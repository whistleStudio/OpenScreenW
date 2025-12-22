import type { ExportConfig, ExportProgress, ExportResult } from './types';
import { VideoFileDecoder } from './videoDecoder';
import { FrameRenderer } from './frameRenderer';
import { VideoMuxer } from './muxer';
import type { ZoomRegion, CropRegion, TrimRegion, AnnotationRegion } from '@/components/video-editor/types';

interface VideoExporterConfig extends ExportConfig {
  videoUrl: string;
  wallpaper: string;
  zoomRegions: ZoomRegion[];
  trimRegions?: TrimRegion[];
  showShadow: boolean;
  shadowIntensity: number;
  showBlur: boolean;
  motionBlurEnabled?: boolean;
  borderRadius?: number;
  padding?: number;
  videoPadding?: number;
  cropRegion: CropRegion;
  annotationRegions?: AnnotationRegion[];
  previewWidth?: number;
  previewHeight?: number;
  onProgress?: (progress: ExportProgress) => void;
}

export class VideoExporter {
  private config: VideoExporterConfig;
  private decoder: VideoFileDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private encoder: VideoEncoder | null = null;
  private muxer: VideoMuxer | null = null;
  private cancelled = false;
  private encodeQueue = 0;
  // Increased queue size for better throughput with hardware encoding
  private readonly MAX_ENCODE_QUEUE = 240; // Doubled for faster processing
  private readonly PROGRESS_UPDATE_INTERVAL = 30; // Update progress every 30 frames for minimal overhead
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
  private selectedCodec: string | undefined; // Track the codec that was actually selected
  // Track muxing promises for parallel processing
  private muxingPromises: Promise<void>[] = [];
  private chunkCount = 0;

  constructor(config: VideoExporterConfig) {
    this.config = config;
  }

  // Calculate the total duration excluding trim regions (in seconds)
  private getEffectiveDuration(totalDuration: number): number {
    const trimRegions = this.config.trimRegions || [];
    const totalTrimDuration = trimRegions.reduce((sum, region) => {
      return sum + (region.endMs - region.startMs) / 1000;
    }, 0);
    return totalDuration - totalTrimDuration;
  }

  private mapEffectiveToSourceTime(effectiveTimeMs: number): number {
    const trimRegions = this.config.trimRegions || [];
    // Sort trim regions by start time
    const sortedTrims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);

    let sourceTimeMs = effectiveTimeMs;

    for (const trim of sortedTrims) {
      // If the source time hasn't reached this trim region yet, we're done
      if (sourceTimeMs < trim.startMs) {
        break;
      }

      // Add the duration of this trim region to the source time
      const trimDuration = trim.endMs - trim.startMs;
      sourceTimeMs += trimDuration;
    }

    return sourceTimeMs;
  }

  async export(): Promise<ExportResult> {
    try {
      this.cleanup();
      this.cancelled = false;

      // Initialize decoder and load video
      this.decoder = new VideoFileDecoder();
      const videoInfo = await this.decoder.loadVideo(this.config.videoUrl);

      // Initialize frame renderer
      this.renderer = new FrameRenderer({
        width: this.config.width,
        height: this.config.height,
        wallpaper: this.config.wallpaper,
        zoomRegions: this.config.zoomRegions,
        showShadow: this.config.showShadow,
        shadowIntensity: this.config.shadowIntensity,
        showBlur: this.config.showBlur,
        motionBlurEnabled: this.config.motionBlurEnabled,
        borderRadius: this.config.borderRadius,
        padding: this.config.padding,
        cropRegion: this.config.cropRegion,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        annotationRegions: this.config.annotationRegions,
        previewWidth: this.config.previewWidth,
        previewHeight: this.config.previewHeight,
      });
      await this.renderer.initialize();

      // Initialize video encoder
      await this.initializeEncoder();

      // Initialize muxer
      this.muxer = new VideoMuxer(this.config, false);
      await this.muxer.initialize();

      // Get the video element for frame extraction
      const videoElement = this.decoder.getVideoElement();
      if (!videoElement) {
        throw new Error('Video element not available');
      }

      // Calculate effective duration and frame count (excluding trim regions)
      const effectiveDuration = this.getEffectiveDuration(videoInfo.duration);
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);
      
      console.log('[VideoExporter] Original duration:', videoInfo.duration, 's');
      console.log('[VideoExporter] Effective duration:', effectiveDuration, 's');
      console.log('[VideoExporter] Total frames to export:', totalFrames);

      // Process frames with optimized seeking strategy
      const frameDuration = 1_000_000 / this.config.frameRate; // in microseconds
      let frameIndex = 0;
      const timeStep = 1 / this.config.frameRate;
      const SEEK_THRESHOLD = 0.1; // Only seek if more than 100ms difference

      while (frameIndex < totalFrames && !this.cancelled) {
        const i = frameIndex;
        const timestamp = i * frameDuration;

        // Map effective time to source time (accounting for trim regions)
        const effectiveTimeMs = (i * timeStep) * 1000;
        const sourceTimeMs = this.mapEffectiveToSourceTime(effectiveTimeMs);
        const videoTime = sourceTimeMs / 1000;
          
        // Only seek if there's a significant time jump (e.g., trim regions or first frame)
        // This dramatically reduces seeks and improves export speed
        const timeDiff = Math.abs(videoElement.currentTime - videoTime);
        const needsSeek = timeDiff > SEEK_THRESHOLD;

        if (i === 0) {
          // First frame: ensure video is ready
          videoElement.currentTime = videoTime;
          await new Promise<void>(resolve => {
            videoElement.requestVideoFrameCallback(() => resolve());
          });
        } else if (needsSeek) {
          // Significant time jump: full seek with event wait
          const seekedPromise = new Promise<void>(resolve => {
            videoElement.addEventListener('seeked', () => resolve(), { once: true });
          });
          
          videoElement.currentTime = videoTime;
          await seekedPromise;
        } else {
          // Consecutive frames: fast path without seek event
          // Set time directly and yield to event loop for frame readiness
          videoElement.currentTime = videoTime;
          // Minimal yield - may need adjustment based on system performance
          await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
        }

        // Create a VideoFrame from the video element (on GPU!)
        const videoFrame = new VideoFrame(videoElement, {
          timestamp,
        });

        // Render the frame with all effects using source timestamp
        const sourceTimestamp = sourceTimeMs * 1000; // Convert to microseconds
        await this.renderer!.renderFrame(videoFrame, sourceTimestamp);
        
        videoFrame.close();

        const canvas = this.renderer!.getCanvas();

        // Create VideoFrame from canvas on GPU without reading pixels
        // @ts-ignore - colorSpace not in TypeScript definitions but works at runtime
        const exportFrame = new VideoFrame(canvas, {
          timestamp,
          duration: frameDuration,
          colorSpace: {
            primaries: 'bt709',
            transfer: 'iec61966-2-1',
            matrix: 'rgb',
            fullRange: true,
          },
        });

        // Check encoder queue before encoding to keep it full
        while (this.encodeQueue >= this.MAX_ENCODE_QUEUE && !this.cancelled) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (this.encoder && this.encoder.state === 'configured') {
          this.encodeQueue++;
          // Use keyframe every 2 seconds for faster encoding and seeking
          const keyframeInterval = Math.floor(this.config.frameRate * 2);
          this.encoder.encode(exportFrame, { keyFrame: i % keyframeInterval === 0 });
        } else {
          console.warn(`[Frame ${i}] Encoder not ready! State: ${this.encoder?.state}`);
        }

        exportFrame.close();

        frameIndex++;

        // Update progress every N frames to reduce overhead
        if (this.config.onProgress && (frameIndex % this.PROGRESS_UPDATE_INTERVAL === 0 || frameIndex === totalFrames)) {
          this.config.onProgress({
            currentFrame: frameIndex,
            totalFrames,
            percentage: (frameIndex / totalFrames) * 100,
            estimatedTimeRemaining: 0,
          });
        }
      }

      if (this.cancelled) {
        return { success: false, error: 'Export cancelled' };
      }

      // Finalize encoding
      if (this.encoder && this.encoder.state === 'configured') {
        await this.encoder.flush();
      }

      // Wait for all muxing operations to complete
      await Promise.all(this.muxingPromises);

      // Finalize muxer and get output blob
      const blob = await this.muxer!.finalize();

      return { success: true, blob };
    } catch (error) {
      console.error('Export error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.cleanup();
    }
  }

  private async initializeEncoder(): Promise<void> {
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    let videoDescription: Uint8Array | undefined;

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        // Capture decoder config metadata from encoder output
        if (meta?.decoderConfig?.description && !videoDescription) {
          const desc = meta.decoderConfig.description;
          videoDescription = new Uint8Array(desc instanceof ArrayBuffer ? desc : (desc as any));
          this.videoDescription = videoDescription;
        }
        // Capture colorSpace from encoder metadata if provided
        if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
          this.videoColorSpace = meta.decoderConfig.colorSpace;
        }

        // Stream chunk to muxer immediately (parallel processing)
        const isFirstChunk = this.chunkCount === 0;
        this.chunkCount++;

        const muxingPromise = (async () => {
          try {
            if (isFirstChunk && this.videoDescription) {
              // Add decoder config for the first chunk
              const colorSpace = this.videoColorSpace || {
                primaries: 'bt709',
                transfer: 'iec61966-2-1',
                matrix: 'rgb',
                fullRange: true,
              };

              const metadata: EncodedVideoChunkMetadata = {
                decoderConfig: {
                  codec: this.selectedCodec!, // selectedCodec is guaranteed to be set after initialization
                  codedWidth: this.config.width,
                  codedHeight: this.config.height,
                  description: this.videoDescription,
                  colorSpace,
                },
              };

              await this.muxer!.addVideoChunk(chunk, metadata);
            } else {
              await this.muxer!.addVideoChunk(chunk, meta);
            }
          } catch (error) {
            console.error('Muxing error:', error);
          }
        })();

        this.muxingPromises.push(muxingPromise);
        this.encodeQueue--;
      },
      error: (error) => {
        console.error('[VideoExporter] Encoder error:', error);
        // Stop export encoding failed
        this.cancelled = true;
      },
    });

    // Try codecs in order of preference: Baseline (faster) -> Main -> High (better quality)
    const codecCandidates = [
      'avc1.42E01E', // H.264 Baseline Profile - fastest encoding
      'avc1.4D401E', // H.264 Main Profile - good balance
      'avc1.640033', // H.264 High Profile - best quality (original)
    ];

    let encoderConfig: VideoEncoderConfig | null = null;
    
    // If user specified a codec not in default list, try it first
    // If it's already in the list, it will be tried in order of preference
    if (this.config.codec && !codecCandidates.includes(this.config.codec)) {
      codecCandidates.unshift(this.config.codec);
    }

    // Try each codec until one is supported
    for (const codec of codecCandidates) {
      const testConfig: VideoEncoderConfig = {
        codec,
        width: this.config.width,
        height: this.config.height,
        bitrate: this.config.bitrate,
        framerate: this.config.frameRate,
        latencyMode: 'realtime',
        bitrateMode: 'variable',
        hardwareAcceleration: 'prefer-hardware',
      };

      // Check hardware support first
      const hardwareSupport = await VideoEncoder.isConfigSupported(testConfig);

      if (hardwareSupport.supported) {
        console.log(`[VideoExporter] Using codec ${codec} with hardware acceleration`);
        encoderConfig = testConfig;
        this.selectedCodec = codec;
        break;
      }

      // Try software encoding
      testConfig.hardwareAcceleration = 'prefer-software';
      const softwareSupport = await VideoEncoder.isConfigSupported(testConfig);

      if (softwareSupport.supported) {
        console.log(`[VideoExporter] Using codec ${codec} with software encoding`);
        encoderConfig = testConfig;
        this.selectedCodec = codec;
        break;
      }
    }

    if (!encoderConfig || !this.selectedCodec) {
      throw new Error('No supported video codec found on this system. Tried: ' + codecCandidates.join(', '));
    }

    this.encoder.configure(encoderConfig);
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.encoder) {
      try {
        if (this.encoder.state === 'configured') {
          this.encoder.close();
        }
      } catch (e) {
        console.warn('Error closing encoder:', e);
      }
      this.encoder = null;
    }

    if (this.decoder) {
      try {
        this.decoder.destroy();
      } catch (e) {
        console.warn('Error destroying decoder:', e);
      }
      this.decoder = null;
    }

    if (this.renderer) {
      try {
        this.renderer.destroy();
      } catch (e) {
        console.warn('Error destroying renderer:', e);
      }
      this.renderer = null;
    }

    this.muxer = null;
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    this.videoDescription = undefined;
    this.videoColorSpace = undefined;
    this.selectedCodec = undefined;
  }
}
