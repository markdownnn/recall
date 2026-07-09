export const MODEL_CDN_BASE_URL = 'https://cdn.teamnyongs.com/models/'

export function modelCdnUrl(path: string): string {
  return new URL(path, MODEL_CDN_BASE_URL).href
}
