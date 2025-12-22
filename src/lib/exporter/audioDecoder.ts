export interface AudioTrackInfo {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  duration: number;
}

export class AudioFileDecoder {
  private audioContext: AudioContext | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private info: AudioTrackInfo | null = null;

  async loadAudio(videoUrl: string): Promise<AudioTrackInfo | null> {
    try {
      // Fetch the video file
      const response = await fetch(videoUrl);
      const arrayBuffer = await response.arrayBuffer();

      // Create audio context
      this.audioContext = new AudioContext();

      // Decode audio data
      this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      this.info = {
        codec: 'decoded', // Codec is abstracted after decoding to PCM
        sampleRate: this.audioBuffer.sampleRate,
        numberOfChannels: this.audioBuffer.numberOfChannels,
        duration: this.audioBuffer.duration,
      };

      console.log('[AudioDecoder] Audio loaded successfully');
      return this.info;
    } catch (error) {
      console.warn('[AudioDecoder] Failed to decode audio:', error);
      return null;
    }
  }

  getAudioBuffer(): AudioBuffer | null {
    return this.audioBuffer;
  }

  getInfo(): AudioTrackInfo | null {
    return this.info;
  }

  /**
   * Extract audio samples for a specific time range
   */
  extractSamples(startTime: number, endTime: number): Float32Array[] | null {
    if (!this.audioBuffer) {
      return null;
    }

    const sampleRate = this.audioBuffer.sampleRate;
    const startSample = Math.floor(startTime * sampleRate);
    const endSample = Math.floor(endTime * sampleRate);
    const length = endSample - startSample;

    if (length <= 0 || startSample >= this.audioBuffer.length) {
      return null;
    }

    const channels: Float32Array[] = [];
    for (let i = 0; i < this.audioBuffer.numberOfChannels; i++) {
      const channelData = this.audioBuffer.getChannelData(i);
      const samples = channelData.slice(startSample, endSample);
      channels.push(samples);
    }

    return channels;
  }

  destroy(): void {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.audioBuffer = null;
  }
}
