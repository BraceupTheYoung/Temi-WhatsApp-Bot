const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { PDFDocument, StandardFonts, PDFName, rgb } = require("pdf-lib");

const CERT_DIR = path.join(__dirname, "certificates");
const TEMPLATE_PDF = path.join(__dirname, "media", "certificate-template.pdf");
const TEMPLATE_PNG = path.join(__dirname, "media", "certificate-template.png");
const TEMPLATE_JPG = path.join(__dirname, "media", "certificate-template.jpeg");

const escapeXml = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const fitFontSize = (name) => {
  const len = name.trim().length;
  if (len <= 16) return 96;
  if (len <= 24) return 80;
  if (len <= 32) return 68;
  return 56;
};

const makeCertId = () => {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TEMI-${year}-${rand}`;
};

const formatDate = (d = new Date()) =>
  d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/**
 * Generate a certificate PNG for a learner.
 * If media/certificate-template.png (or .jpeg) exists (e.g. exported from
 * Canva / Certifier), the name is composited onto it. Otherwise a branded
 * Témí certificate is rendered from scratch.
 *
 * @param {string} fullName - name as it should appear on certificate
 * @param {object} opts - { course, date, certId }
 * @returns {Promise<{ filePath, certId, date }>}
 */
async function generateCertificate(fullName, opts = {}) {
  const name = String(fullName || "").trim();
  if (!name) throw new Error("fullName is required");

  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

  const course = opts.course || "AI Tools for Teachers";
  const dateStr = opts.date || formatDate();
  const certId = opts.certId || makeCertId();
  const safeName = escapeXml(name.toUpperCase());
  const safeCourse = escapeXml(course);
  const safeDate = escapeXml(dateStr);
  const safeId = escapeXml(certId);

  const safeFile = name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40) || "certificate";
  const filePath = path.join(CERT_DIR, `${safeFile}-${certId}.png`);

  // 1) Custom template mode — drop your Canva/Certifier export at
  //    media/certificate-template.png and names go on top automatically.
  const template = fs.existsSync(TEMPLATE_PNG)
    ? TEMPLATE_PNG
    : fs.existsSync(TEMPLATE_JPG)
      ? TEMPLATE_JPG
      : null;

  if (template) {
    const meta = await sharp(template).metadata();
    const W = meta.width || 1600;
    const H = meta.height || 1200;
    // Tuned for Brace-Up template (902x504): name sits on the blank
    // underline, date replaces "[blank date]".
    const scale = W / 902;
    const fontSize = Math.round(scale * Math.min(fitFontSize(name) * 0.45, 44));
    const nameY = Math.round(H * 0.525);
    const courseY = Math.round(H * 0.59);
    const dateY = Math.round(H * 0.64);
    const dateFont = Math.round(scale * 17);
    const courseFont = Math.round(scale * 16);
    const svg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <text x="${W / 2}" y="${nameY}" text-anchor="middle"
          font-family="Georgia, 'Times New Roman', serif" font-weight="bold"
          font-size="${fontSize}" fill="#0b3d0b" letter-spacing="1">${safeName}</text>
        <rect x="${W * 0.12}" y="${courseY - courseFont - 12}" width="${W * 0.76}" height="${dateY - courseY + dateFont + 24}" fill="#ffffff"/>
        <text x="${W / 2}" y="${courseY}" text-anchor="middle"
          font-family="Arial, sans-serif" font-size="${courseFont}"
          fill="#222222">for successfully completing the AI Tool Teachers Course</text>
        <text x="${W / 2}" y="${dateY}" text-anchor="middle"
          font-family="Arial, sans-serif" font-size="${dateFont}"
          fill="#333333">${safeDate}  •  ${safeId}</text>
      </svg>`);
    await sharp(template).composite([{ input: svg, top: 0, left: 0 }]).png().toFile(filePath);
    return { filePath, certId, date: dateStr };
  }

  // 2) Built-in branded template (matches your green/yellow Témí style)
  const W = 1600;
  const H = 1200;
  const fontSize = fitFontSize(name);

  const svg = Buffer.from(`
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#177117"/>
    <rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="#F5E600" stroke-width="6"/>
    <rect x="60" y="60" width="${W - 120}" height="${H - 120}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.6"/>

    <text x="${W / 2}" y="230" text-anchor="middle" font-family="Georgia, serif" font-style="italic"
      font-size="110" fill="#F5E600">Congratulations</text>

    <text x="${W / 2}" y="330" text-anchor="middle" font-family="Arial, sans-serif"
      font-size="30" letter-spacing="4" fill="#ffffff">THIS CERTIFICATE IS PROUDLY PRESENTED TO</text>

    <text x="${W / 2}" y="470" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
      font-weight="bold" font-size="${fontSize}" fill="#ffffff" letter-spacing="2">${safeName}</text>

    <line x1="350" y1="520" x2="1250" y2="520" stroke="#F5E600" stroke-width="3"/>

    <text x="${W / 2}" y="590" text-anchor="middle" font-family="Arial, sans-serif"
      font-size="34" fill="#ffffff">has successfully completed the</text>
    <text x="${W / 2}" y="650" text-anchor="middle" font-family="Arial, sans-serif"
      font-weight="bold" font-size="44" fill="#ffffff">${safeCourse}</text>
    <text x="${W / 2}" y="710" text-anchor="middle" font-family="Arial, sans-serif"
      font-size="30" fill="#e8e8e8">powered by Brace Up The Young Foundation</text>
    <text x="${W / 2}" y="755" text-anchor="middle" font-family="Arial, sans-serif" font-style="italic"
      font-size="28" fill="#F5E600">Témí says: Learn AI. Teach Better.</text>

    <text x="150" y="${H - 150}" font-family="Arial, sans-serif" font-size="26" fill="#ffffff">Date: ${safeDate}</text>
    <text x="150" y="${H - 110}" font-family="Arial, sans-serif" font-size="22" fill="#dddddd">ID: ${safeId}</text>
    <text x="${W - 150}" y="${H - 150}" text-anchor="end" font-family="Arial, sans-serif" font-size="26" fill="#ffffff">Brace-Up The Young</text>
    <text x="${W - 150}" y="${H - 110}" text-anchor="end" font-family="Arial, sans-serif" font-size="22" fill="#dddddd">Témí AI Training</text>
  </svg>`);

  await sharp({ create: { width: W, height: H, channels: 4, background: "#177117" } })
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toFile(filePath);

  return { filePath, certId, date: dateStr };
}

module.exports = { generateCertificate, generateCertificatePDF };

/**
 * Shrink font size until text fits maxWidth (in PDF points).
 */
function fitToWidth(font, text, maxWidth, startSize, minSize) {
  let size = startSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 1;
  }
  return size;
}

/**
 * Generate a certificate PDF using the org template
 * (media/certificate-template.pdf, A4 landscape 842x595pt).
 *
 * Blanks mapped from the template (measured Dec 2025):
 *  - Name:   long centered underline (~y 241) → text baseline y=253, center x=431
 *  - Course: inline blank after "completed the" (~y 198) → baseline y=208, center x=536
 *  - Date:   inline blank after "on" (~y 182) → baseline y=191, center x=257
 *  - Cert ID: tiny grey footer, bottom-center (org has no ID field).
 *
 * Long names/courses/dates auto-shrink to fit their underline.
 *
 * @param {string} fullName - name as it should appear on certificate
 * @param {object} opts - { course, date, certId }
 * @returns {Promise<{ filePath, certId, date }>}
 */
async function generateCertificatePDF(fullName, opts = {}) {
  const name = String(fullName || "").trim();
  if (!name) throw new Error("fullName is required");
  if (!fs.existsSync(TEMPLATE_PDF)) {
    throw new Error(`PDF template missing at ${TEMPLATE_PDF}`);
  }

  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

  const course = String(opts.course || "AI Tools for Teachers").trim();
  const dateStr = opts.date || formatDate();
  const certId = opts.certId || makeCertId();

  const templateBytes = fs.readFileSync(TEMPLATE_PDF);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const page = pdfDoc.getPages()[0];

  // The org template's MediaBox starts at y≈8.58, not 0. pdf-lib draws
  // relative to (0,0), so every Y we specify lands ~8.58pt too low.
  // Read the offset at runtime so a re-exported template still works.
  let yOff = 0;
  try {
    const box = page.node.get(PDFName.of("MediaBox"));
    if (box && typeof box.size === "function" && box.size() === 4) {
      const y0 = box.get(1);
      yOff = (y0 && typeof y0.asNumber === "function" ? y0.asNumber() : Number(y0)) || 0;
    }
  } catch { /* default yOff = 0 */ }

  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const ink = rgb(0.08, 0.08, 0.08);
  const green = rgb(0.04, 0.24, 0.09);

  // 1) NAME — long centered underline (line y≈241)
  const nameText = name.toUpperCase();
  const nameSize = fitToWidth(bold, nameText, 280, 30, 13);
  const nameW = bold.widthOfTextAtSize(nameText, nameSize);
  page.drawText(nameText, {
    x: 431 - nameW / 2,
    y: 253 + yOff,
    size: nameSize,
    font: bold,
    color: green,
  });

  // 2) COURSE — inline blank ("completed the ___ course", line y≈199)
  const courseSize = fitToWidth(regular, course, 190, 14, 9);
  const courseW = regular.widthOfTextAtSize(course, courseSize);
  page.drawText(course, {
    x: 536 - courseW / 2,
    y: 204 + yOff,
    size: courseSize,
    font: regular,
    color: ink,
  });

  // 3) DATE — inline blank ("on ___ demonstrating", line y≈182)
  const dateSize = fitToWidth(regular, dateStr, 96, 12, 8);
  const dateW = regular.widthOfTextAtSize(dateStr, dateSize);
  page.drawText(dateStr, {
    x: 257 - dateW / 2,
    y: 186 + yOff,
    size: dateSize,
    font: regular,
    color: ink,
  });

  // 4) CERT ID — tiny footer, out of the org design's way
  const idText = `ID: ${certId}`;
  const idSize = 7.5;
  const idW = regular.widthOfTextAtSize(idText, idSize);
  page.drawText(idText, {
    x: 421 - idW / 2,
    y: 24 + yOff,
    size: idSize,
    font: regular,
    color: rgb(0.45, 0.45, 0.45),
  });

  const safeFile = name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40) || "certificate";
  const filePath = path.join(CERT_DIR, `${safeFile}-${certId}.pdf`);
  fs.writeFileSync(filePath, await pdfDoc.save());

  return { filePath, certId, date: dateStr };
}
