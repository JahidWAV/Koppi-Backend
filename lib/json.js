export function sendJson(res, status, payload) {
  res.status(status).json(payload);
}
