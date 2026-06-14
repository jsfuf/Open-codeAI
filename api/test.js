module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    method: req.method,
    bodyType: typeof req.body,
    bodyIsObj: req.body && typeof req.body === 'object',
    bodyKeys: req.body ? Object.keys(req.body) : [],
    hasMessages: !!(req.body && req.body.messages),
    rawBody: typeof req.body === 'string' ? req.body : null
  }));
};
