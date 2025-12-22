export interface DecodedVideoInfo {
  width: number;
  height: number;
  duration: number; // in seconds
  frameRate: number;
  codec: string;
}

export class VideoFileDecoder {
  private info: DecodedVideoInfo | null = null;
  private videoElement: HTMLVideoElement | null = null;

  async loadVideo(videoUrl: string): Promise<DecodedVideoInfo> {
    this.videoElement = document.createElement('video');
    this.videoElement.src = videoUrl;
    this.videoElement.preload = 'metadata';

    return new Promise((resolve, reject) => {
      this.videoElement!.addEventListener('loadedmetadata', () => {
        const video = this.videoElement!;
        
        this.info = {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          frameRate: 25,
          codec: 'avc1.640033',
        };

        resolve(this.info);
      });

      this.videoElement!.addEventListener('error', (e) => {
        reject(new Error(`Failed to load video: ${e}`));
      });
    });
  }

  /**
   * Get video element for seeking
   */
  getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  getInfo(): DecodedVideoInfo | null {
    return this.info;
  }

  destroy(): void {
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.src = '';
      this.videoElement = null;
    }
  }
}

/**
 * Fast video decoder using WebCodecs and MP4Box for high-performance frame extraction
 * This decoder eliminates the slow video element seeking bottleneck
 */
export class FastVideoDecoder {
  private decoder: VideoDecoder | null = null;
  private frameCache: Map<number, VideoFrame> = new Map();
  private mp4File: any = null;
  private videoTrack: any = null;
  private info: DecodedVideoInfo | null = null;
  private isReady = false;
  
  // Batch decoding configuration
  private readonly CACHE_SIZE = 120; // Cache 120 frames (2 seconds @ 60fps)
  private readonly DECODE_BATCH_SIZE = 30; // Decode 30 frames per batch
  
  async loadVideo(videoUrl: string): Promise<DecodedVideoInfo> {
    // 1. Fetch video file
    const response = await fetch(videoUrl);
    const arrayBuffer = await response.arrayBuffer();
    
    // 2. Use MP4Box to parse container
    const MP4Box = (window as any).MP4Box;
    if (!MP4Box) {
      throw new Error('MP4Box library not loaded. Please ensure mp4box.all.min.js is included from CDN in index.html');
    }
    
    this.mp4File = MP4Box.createFile();
    
    return new Promise((resolve, reject) => {
      this.mp4File.onReady = (info: any) => {
        // Find video track
        this.videoTrack = info.videoTracks[0];
        
        if (!this.videoTrack) {
          reject(new Error('No video track found in file'));
          return;
        }
        
        this.info = {
          width: this.videoTrack.track_width,
          height: this.videoTrack.track_height,
          duration: info.duration / info.timescale,
          frameRate: this.videoTrack.nb_samples / (info.duration / info.timescale),
          codec: this.videoTrack.codec,
        };
        
        // 3. Initialize VideoDecoder
        this.initDecoder().then(() => {
          this.isReady = true;
          resolve(this.info!);
        }).catch(reject);
      };
      
      this.mp4File.onError = (e: any) => reject(new Error(`MP4Box error: ${e}`));
      
      // Parse file
      (arrayBuffer as any).fileStart = 0;
      this.mp4File.appendBuffer(arrayBuffer);
      this.mp4File.flush();
    });
  }
  
  private async initDecoder(): Promise<void> {
    if (!this.videoTrack || !this.mp4File) {
      throw new Error('Video track not initialized');
    }
    
    const config: VideoDecoderConfig = {
      codec: this.videoTrack.codec,
      codedWidth: this.videoTrack.track_width,
      codedHeight: this.videoTrack.track_height,
      hardwareAcceleration: 'prefer-hardware' as any,
    };
    
    // Get decoder configuration description
    try {
      const trak = this.mp4File.getTrackById(this.videoTrack.id);
      const stsd = trak?.mdia?.minf?.stbl?.stsd;
      if (stsd && stsd.entries && stsd.entries.length > 0) {
        const entry = stsd.entries[0];
        const descriptionBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        
        if (descriptionBox) {
          config.description = this.getDecoderDescription(descriptionBox);
        }
      }
    } catch (error) {
      console.warn('[FastVideoDecoder] Could not extract decoder description:', error);
    }
    
    let decoderError: Error | null = null;
    
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        // Calculate frame number from timestamp
        if (!this.info) {
          console.warn('[FastVideoDecoder] Received frame but info is null');
          frame.close();
          return;
        }
        
        const frameNumber = Math.floor((frame.timestamp / 1000000) * this.info.frameRate);
        this.frameCache.set(frameNumber, frame);
        
        // Control cache size - remove oldest frames
        if (this.frameCache.size > this.CACHE_SIZE) {
          const oldestFrame = Math.min(...this.frameCache.keys());
          const frameToRemove = this.frameCache.get(oldestFrame);
          if (frameToRemove) {
            frameToRemove.close();
            this.frameCache.delete(oldestFrame);
          }
        }
      },
      error: (e) => {
        console.error('[FastVideoDecoder] VideoDecoder error:', e);
        decoderError = e instanceof Error ? e : new Error(String(e));
      }
    });
    
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error(`Video codec ${this.videoTrack.codec} not supported`);
    }
    
    this.decoder.configure(config);
    
    // Check if there was an error during initialization
    if (decoderError) {
      throw decoderError;
    }
  }
  
  private getDecoderDescription(box: any): Uint8Array {
    // Extract decoder configuration from avcC/hvcC/vpcC/av1C box
    // This is a simplified version that works with MP4Box structure
    try {
      if (box.write) {
        // MP4Box boxes have a write method to serialize
        const stream = {
          data: new Uint8Array(box.size),
          position: 0,
          writeUint8: function(value: number) {
            this.data[this.position++] = value;
          },
          writeUint16: function(value: number) {
            this.data[this.position++] = (value >> 8) & 0xff;
            this.data[this.position++] = value & 0xff;
          },
          writeUint32: function(value: number) {
            this.data[this.position++] = (value >> 24) & 0xff;
            this.data[this.position++] = (value >> 16) & 0xff;
            this.data[this.position++] = (value >> 8) & 0xff;
            this.data[this.position++] = value & 0xff;
          },
          writeUint8Array: function(arr: Uint8Array) {
            this.data.set(arr, this.position);
            this.position += arr.length;
          }
        };
        
        box.write(stream);
        return stream.data.slice(0, stream.position);
      }
    } catch (error) {
      console.warn('[FastVideoDecoder] Error extracting decoder description:', error);
    }
    
    return new Uint8Array(0);
  }
  
  /**
   * Prefetch and decode a range of frames
   */
  async prefetchFrames(startFrame: number, count: number): Promise<void> {
    if (!this.decoder || !this.mp4File || !this.videoTrack) return;
    
    // Get total number of samples to prevent out-of-bounds access
    const totalSamples = this.videoTrack.nb_samples;
    
    // Set up extraction options
    this.mp4File.setExtractionOptions(this.videoTrack.id, null, { 
      nbSamples: count 
    });
    
    const endFrame = Math.min(startFrame + count, totalSamples);
    
    for (let i = startFrame; i < endFrame; i++) {
      // Skip already cached frames
      if (this.frameCache.has(i)) continue;
      
      try {
        // Get sample data for this frame (MP4Box uses 1-based indexing)
        const sample = this.mp4File.getSample(this.videoTrack.id, i + 1);
        
        if (sample) {
          const chunk = new EncodedVideoChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: (sample.cts / this.mp4File.getInfo().timescale) * 1000000, // Convert to microseconds
            duration: (sample.duration / this.mp4File.getInfo().timescale) * 1000000,
            data: sample.data
          });
          
          if (this.decoder.state === 'configured') {
            this.decoder.decode(chunk);
          }
        }
      } catch (error) {
        // Sample might not exist, continue
        console.warn(`[FastVideoDecoder] Could not decode frame ${i}:`, error);
      }
    }
    
    // Wait for decoding to complete
    if (this.decoder.state === 'configured') {
      await this.decoder.flush();
    }
  }
  
  /**
   * Get frame at specific time (in milliseconds)
   */
  async getFrameAtTime(timeMs: number): Promise<VideoFrame | null> {
    if (!this.info) return null;
    
    const frameNumber = Math.floor((timeMs / 1000) * this.info.frameRate);
    
    // If frame is already cached, return it
    if (this.frameCache.has(frameNumber)) {
      return this.frameCache.get(frameNumber)!;
    }
    
    // Otherwise, prefetch this frame and nearby frames
    await this.prefetchFrames(frameNumber, this.DECODE_BATCH_SIZE);
    
    return this.frameCache.get(frameNumber) || null;
  }
  
  getInfo(): DecodedVideoInfo | null {
    return this.info;
  }
  
  destroy(): void {
    // Clear all cached frames
    for (const frame of this.frameCache.values()) {
      frame.close();
    }
    this.frameCache.clear();
    
    if (this.decoder) {
      if (this.decoder.state !== 'closed') {
        this.decoder.close();
      }
      this.decoder = null;
    }
    
    this.mp4File = null;
    this.videoTrack = null;
    this.isReady = false;
  }
}
