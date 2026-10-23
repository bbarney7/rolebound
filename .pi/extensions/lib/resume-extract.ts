/** Both parsers operate on local buffers; neither receives a URL or filename. */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("input is not a valid PDF");
  const { default: PDFParser } = await import("pdf2json");
  const parser = new PDFParser(null, true, "");
  // pdf2json 3.x assumes the Buffer starts at offset zero in its backing array.
  const input = Buffer.alloc(bytes.length); bytes.copy(input);
  try {
    return await new Promise<string>((resolve, reject) => {
      parser.once("pdfParser_dataError", (error: { parserError: unknown }) => reject(new Error(String(error.parserError))));
      parser.once("pdfParser_dataReady", () => resolve(parser.getRawTextContent()));
      parser.parseBuffer(input, 0);
    });
  } finally { parser.destroy(); }
}

export async function extractDocxText(bytes: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: bytes })).value;
}
