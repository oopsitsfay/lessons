// GET /api/test/meta/:id?seed=0x…&d=16 → Test HashPrint metadata.
const { HP, metadata } = require('../../_lib/params.js');

module.exports = (req, res) => metadata(req, res, HP.COLLECTIONS.test);
