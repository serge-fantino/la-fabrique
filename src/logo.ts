// La Fabrique's mark: a sawtooth-roofed workshop with its chimney, ink on
// the épicerie's background, a spark of accent above.
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="8" fill="#18211B"/>
  <path d="M5 26V14.5l6 4v-4l6 4v-4l6 4V9h3.5v17z" fill="#F3F4EE"/>
  <path d="M8 22h3v4H8zM14 22h3v4h-3zM20 22h3v4h-3z" fill="#18211B"/>
  <circle cx="24.75" cy="5.5" r="2" fill="#C23D17"/>
</svg>`;

// The same mark inline in the page, hidden from screen readers (the
// wordmark next to it says the name).
export function logoMark(className: string): string {
  return LOGO_SVG.replace("<svg ", `<svg class="${className}" aria-hidden="true" focusable="false" `);
}
