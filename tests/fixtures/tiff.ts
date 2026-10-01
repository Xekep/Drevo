import sharp from "sharp";

/** Three visibly distinct pages, in the same order as the input frames. */
export async function sampleTiff(width = 40, height = 30) {
  const pages = ["#ff0000", "#00ff00", "#0000ff"];
  const frames = await Promise.all(
    pages.map((background) =>
      sharp({ create: { width, height, channels: 3, background } })
        .raw()
        .toBuffer(),
    ),
  );
  return sharp(Buffer.concat(frames), {
    raw: {
      width,
      height: height * pages.length,
      pageHeight: height,
      channels: 3,
    },
  })
    .tiff({ compression: "lzw" })
    .toBuffer();
}
