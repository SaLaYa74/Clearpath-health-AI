/**
 * ClearPath Health — Anthropic API Proxy
 * Vercel serverless function: /api/generate
 *
 * DEVELOPER SETUP:
 * 1. Go to console.anthropic.com → create account → add billing → generate API key
 * 2. In Vercel dashboard → your project → Settings → Environment Variables
 * 3. Add: ANTHROPIC_API_KEY = sk-ant-...your key...
 * 4. That's it. The key never touches the browser.
 *
 * Deploy instructions:
 * - Put this file at /api/generate.js in your project root
 * - Drag the whole folder (or connect GitHub repo) to Vercel
 * - The HTML file goes in /public/index.html
 */

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured. Add ANTHROPIC_API_KEY to Vercel environment variables.' });
  }

  try {
    const body = req.body;
    const isStreaming = body.stream === true;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err });
    }

    if (isStreaming) {
      // Stream response back to client
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
    } else {
      // Return JSON response
      const data = await upstream.json();
      return res.status(200).json(data);
    }

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Internal proxy error', detail: err.message });
  }
}
