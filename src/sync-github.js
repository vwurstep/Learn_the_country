/* Sync backend: one JSON file on a branch of a GitHub repo, written with a fine-grained personal
   access token (Contents: read & write on that repo only). Implements the backend interface
   from store.js: {id, label, pull(), push(doc)}. */

export function githubBackend({ token, repo = 'vwurstep/Learn_the_country', branch = 'userdata', path = 'user.json' }) {
  let sha = null;
  const api = (method, body) => fetch(
    `https://api.github.com/repos/${repo}/contents/${path}` + (method === 'GET' ? `?ref=${branch}&t=${Date.now()}` : ''),
    { method, cache: 'no-store', body: body && JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });

  async function ensureBranch() {
    // the branch is created from main the first time (an orphan branch isn't possible via this API)
    const ref = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`, { headers: { Authorization: `Bearer ${token}` } });
    if (ref.ok) return;
    const main = await (await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/main`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const r = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: main.object.sha }) });
    if (!r.ok) throw new Error(`GitHub ${r.status} (create branch)`);
  }

  return {
    id: 'github',
    label: `GitHub ${repo} (${branch})`,
    async pull() {
      const res = await api('GET');
      if (res.status === 404) { sha = null; return null; }
      if (res.status === 401) throw new Error('token rejected');
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const file = await res.json();
      sha = file.sha;
      const text = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
      return JSON.parse(text);
    },
    async push(doc) {
      const bytes = new TextEncoder().encode(JSON.stringify(doc, null, 1));
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      let res = await api('PUT', { message: 'Sync learning progress', branch, sha: sha || undefined, content: btoa(bin) });
      if (res.status === 404 || (res.status === 422 && !sha)) {
        await ensureBranch();
        res = await api('PUT', { message: 'Sync learning progress', branch, content: btoa(bin) });
      }
      if (res.status === 409 || res.status === 422) throw Object.assign(new Error('conflict'), { conflict: true });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      sha = (await res.json()).content.sha;
    },
  };
}
