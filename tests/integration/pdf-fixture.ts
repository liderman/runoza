// Two-page, text-only fixture with byte-accurate cross references.
export function policyPdf(text: string) {
  const content = text ? "BT /F1 12 Tf 60 700 Td (" + text + ") Tj ET\n" : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + content.length + " >>\nstream\n" + content + "endstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += i + 1 + " 0 obj\n" + obj + "\nendobj\n";
  }
  const xref = pdf.length;
  pdf +=
    "xref\n0 7\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  return Buffer.from(pdf, "ascii");
}
