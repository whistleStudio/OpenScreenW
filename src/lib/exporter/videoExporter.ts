import type { ExportConfig, ExportProgress, ExportResult } from './types';
import { FastVideoDecoder } from './videoDecoder';
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
  private decoder: FastVideoDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private encoder: VideoEncoder | null = null;
  private muxer: VideoMuxer | null = null;
  private cancelled = false;
  private encodeQueue = 0;
  // Increased queue size for better throughput with hardware encoding
  private readonly MAX_ENCODE_QUEUE = 240; // Increased from 120 to 240
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
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

  /**
   * Pre-build frame number to source video time mapping table
   * This avoids recalculating time mappings for every frame during export
   */
  private buildTimeMap(totalFrames: number): Map<number, number> {
    const timeMap = new Map<number, number>();
    const trimRegions = this.config.trimRegions || [];
    const sortedTrims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
    
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const effectiveTimeMs = (frameIdx / this.config.frameRate) * 1000;
      let sourceTimeMs = effectiveTimeMs;
      
      for (const trim of sortedTrims) {
        if (sourceTimeMs < trim.startMs) break;
        sourceTimeMs += (trim.endMs - trim.startMs);
      }
      
      timeMap.set(frameIdx, sourceTimeMs);
    }
    
    return timeMap;
  }

  async export(): Promise<ExportResult> {
    try {
      this.cleanup();
      this.cancelled = false;

      // Initialize decoder and load video using FastVideoDecoder
      this.decoder = new FastVideoDecoder();
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

      // Calculate effective duration and frame count (excluding trim regions)
      const effectiveDuration = this.getEffectiveDuration(videoInfo.duration);
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);
      
      console.log('[VideoExporter] Original duration:', videoInfo.duration, 's');
      console.log('[VideoExporter] Effective duration:', effectiveDuration, 's');
      console.log('[VideoExporter] Total frames to export:', totalFrames);

      // Pre-build time mapping table to avoid per-frame calculations
      const timeMap = this.buildTimeMap(totalFrames);
      
      // Process frames with batch prefetching
      const frameDuration = 1_000_000 / this.config.frameRate; // in microseconds
      const PREFETCH_BATCH = 60; // Prefetch 60 frames at a time
      let frameIndex = 0;

      while (frameIndex < totalFrames && !this.cancelled) {
        const batchStart = frameIndex;
        const batchEnd = Math.min(frameIndex + PREFETCH_BATCH, totalFrames);
        
        // Batch prefetch frames
        const prefetchPromises: Promise<VideoFrame | null>[] = [];
        for (let i = batchStart; i < batchEnd; i++) {
          const sourceTimeMs = timeMap.get(i)!;
          prefetchPromises.push(this.decoder!.getFrameAtTime(sourceTimeMs));
        }
        
        const prefetchedFrames = await Promise.all(prefetchPromises);
        
        // Process each frame in the batch
        for (let i = 0; i < prefetchedFrames.length && !this.cancelled; i++) {
          const videoFrame = prefetchedFrames[i];
          if (!videoFrame) {
            console.warn(`[VideoExporter] Frame ${batchStart + i} is null, skipping`);
            continue;
          }
          
          const timestamp = (batchStart + i) * frameDuration;
          const sourceTimeMs = timeMap.get(batchStart + i)!;
          
          // Render the frame with all effects using source timestamp
          const sourceTimestamp = sourceTimeMs * 1000; // Convert to microseconds
          await this.renderer!.renderFrame(videoFrame, sourceTimestamp);
          
          const canvas = this.renderer!.getCanvas();
          
          // Create VideoFrame from canvas for encoding
          const exportFrame = new VideoFrame(canvas, {
            timestamp,
            duration: frameDuration,
            // @ts-ignore - colorSpace not in TypeScript definitions but works at runtime
            colorSpace: {
              primaries: 'bt709',
              transfer: 'iec61966-2-1',
              matrix: 'rgb',
              fullRange: true,
            },
          });
          
          // Wait for encode queue to have space
          while (this.encodeQueue >= this.MAX_ENCODE_QUEUE && !this.cancelled) {
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          
          // Encode frame
          if (this.encoder && this.encoder.state === 'configured') {
            this.encodeQueue++;
            this.encoder.encode(exportFrame, { 
              keyFrame: (batchStart + i) % 150 === 0 
            });
          }
          
          exportFrame.close();
          
          // Update progress
          frameIndex++;
          if (this.config.onProgress) {
            this.config.onProgress({
              currentFrame: frameIndex,
              totalFrames,
              percentage: (frameIndex / totalFrames) * 100,
              estimatedTimeRemaining: 0,
            });
          }
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
                  codec: this.config.codec || 'avc1.42001f', // Use Baseline Profile
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

    const codec = this.config.codec || 'avc1.42001f'; // Use H.264 Baseline Profile for better compatibility
    
    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.frameRate,
      latencyMode: 'quality', // Keep quality for better output
      bitrateMode: 'variable', // VBR is faster than CBR
      hardwareAcceleration: 'prefer-hardware',
    };

    // Check hardware support first
    const hardwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);

    if (hardwareSupport.supported) {
      // Use hardware encoding
      console.log('[VideoExporter] Using hardware acceleration');
      this.encoder.configure(encoderConfig);
    } else {
      // Fall back to software encoding
      console.log('[VideoExporter] Hardware not supported, using software encoding');
      encoderConfig.hardwareAcceleration = 'prefer-software';
      
      const softwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!softwareSupport.supported) {
        throw new Error('Video encoding not supported on this system');
      }
      
      this.encoder.configure(encoderConfig);
    }
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
  }
}
