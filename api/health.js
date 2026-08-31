export const config = {
  runtime: 'nodejs20.x'
}

export default function handler(_req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', 'application/json')
  res.status(200).json({ ok: true, service: 'flow-player-proxy', time: Date.now() })
}
