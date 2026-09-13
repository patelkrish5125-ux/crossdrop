/**
 * CrossDrop QR Code Generator
 * Uses the battle-tested, spec-compliant qrcode engine (ISO/IEC 18004)
 * with Error Correction Level M for guaranteed scanning reliability across all
 * iOS Safari, Android Chrome, and native camera apps.
 */
import QRCode from 'qrcode';

export async function generateQRCodeSVG(text: string, pixelSize = 200): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    width: pixelSize,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
}

export async function generateQRCodeDataURL(text: string, pixelSize = 256): Promise<string> {
  return QRCode.toDataURL(text, {
    width: pixelSize,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
}
