'use strict';

// Função Node no mesmo domínio do site. Credenciais existem somente no ambiente.
const { createPixHandler } = require('../lib/pix-handler.cjs');
module.exports = createPixHandler();
