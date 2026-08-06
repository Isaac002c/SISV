// URLs relativas — o Next.js proxy (next.config.js rewrites) encaminha para o backend
const API_URL = '';

export const getAuthHeaders = () => {
  if (typeof window !== 'undefined') {
    let token =
      localStorage.getItem('token') ||
      localStorage.getItem('auth-token') ||
      '';

    if (!token && document.cookie) {
      const cookies = document.cookie.split(';').reduce((acc, cookie) => {
        const [key, value] = cookie.trim().split('=');
        acc[key] = value;
        return acc;
      }, {});
      token = cookies['auth-token'] || cookies['token'] || '';
    }

    return {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    };
  }

  return { 'Content-Type': 'application/json' };
};

export const downloadAuthenticated = async (endpoint, { method = 'GET', body, filename = 'export.csv' } = {}) => {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers: { ...getAuthHeaders() },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = JSON.parse(await res.text());
      message = data.error || data.message || message;
    } catch { /* noop */ }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

export const apiRequest = async (endpoint, options = {}) => {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      ...getAuthHeaders(),
      ...(options.headers || {}),
    },
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    try {
      const errorData = JSON.parse(text);
      errorMessage = errorData.error || errorData.message || errorMessage;
    } catch {
      errorMessage = text || errorMessage;
    }
    throw new Error(errorMessage);
  }

  if (!text) return { success: true, data: null };

  return JSON.parse(text);
};

// Baixa um arquivo autenticado (download controlado pelo backend) como blob URL.
// Usado para visualizar/baixar documentos sem expor URL pública — envia o token
// no header Authorization (um <a href> comum não conseguiria).
export const apiBlobUrl = async (endpoint) => {
  const res = await fetch(`${API_URL}${endpoint}`, {
    headers: { ...getAuthHeaders() },
    credentials: 'include',
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = JSON.parse(await res.text()).error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
};

// Abre (nova aba) ou baixa um documento pelo endpoint controlado.
export const openDocument = async (endpoint, { download = false, filename } = {}) => {
  const url = await apiBlobUrl(endpoint);
  if (download) {
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'documento';
    document.body.appendChild(a); a.click(); a.remove();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};

