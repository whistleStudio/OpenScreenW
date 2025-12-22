// Type definitions for mp4box
// Since mp4box doesn't provide official TypeScript types, we declare minimal types here

declare module 'mp4box' {
  const MP4Box: {
    createFile(): any;
    // Add other MP4Box exports as needed
  };
  export default MP4Box;
}
