// GET /api/meta/:id?seed=0x…&d=16 → HashPrints metadata.
const { HP, metadata } = require('../_lib/params.js');

module.exports = (req, res) => metadata(req, res, HP.COLLECTIONS.main);
