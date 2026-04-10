const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:8000';

export function getBackendBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_BACKEND_BASE_URL?.trim();
  return configuredBaseUrl
    ? configuredBaseUrl.replace(/\/+$/, '')
    : DEFAULT_BACKEND_BASE_URL;
}

export function buildBackendUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getBackendBaseUrl()}${normalizedPath}`;
}
