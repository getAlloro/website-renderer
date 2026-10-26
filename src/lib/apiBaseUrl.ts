// The Alloro app origin this renderer talks to: form submissions post there and versioned
// imports are fetched from there. The proving runtime points it at a local app.
export function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || 'https://app.getalloro.com';
}
