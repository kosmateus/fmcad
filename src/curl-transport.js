// Parsing is safe and local. Physical posting is private to broker composition.
const { parseCurlResponse } = require('./dist/fusion-transport/curl');
module.exports = { parseCurlResponse };
