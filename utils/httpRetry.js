const axios = require('./nitradoHttp');

async function get(url, options = {}) {
  return axios.get(url, options);
}

async function post(url, data, options = {}) {
  return axios.post(url, data, options);
}

module.exports = { get, post };
