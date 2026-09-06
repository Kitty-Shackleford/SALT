'use strict';

const dns = require('dns');
const net = require('net');

const blockedAddresses = new net.BlockList();
[
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, 'ipv4'));
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
blockedAddresses.addSubnet('fc00::', 7, 'ipv6');
blockedAddresses.addSubnet('fe80::', 10, 'ipv6');
blockedAddresses.addSubnet('ff00::', 8, 'ipv6');
blockedAddresses.addSubnet('2001::', 23, 'ipv6');
blockedAddresses.addSubnet('2001:db8::', 32, 'ipv6');
blockedAddresses.addSubnet('2002::', 16, 'ipv6');
blockedAddresses.addSubnet('3fff::', 20, 'ipv6');

const publicIpv6Addresses = new net.BlockList();
publicIpv6Addresses.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address) {
  const normalized = String(address || '').toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return !blockedAddresses.check(mappedIpv4, 'ipv4');
  const family = net.isIP(normalized);
  if (family === 4) return !blockedAddresses.check(normalized, 'ipv4');
  if (family === 6) {
    return publicIpv6Addresses.check(normalized, 'ipv6')
      && !blockedAddresses.check(normalized, 'ipv6');
  }
  return false;
}

function createPublicAddressLookup(resolver = dns.lookup) {
  return function publicAddressLookup(hostname, options, callback) {
    const lookupOptions = typeof options === 'number' ? { family: options } : { ...(options || {}) };
    resolver(hostname, { ...lookupOptions, all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      const resolved = Array.isArray(addresses) ? addresses : [];
      if (!resolved.length || resolved.some(entry => !isPublicAddress(entry.address))) {
        const denied = new Error('AI provider resolved to a non-public network address');
        denied.code = 'AI_PROVIDER_ADDRESS_NOT_ALLOWED';
        return callback(denied);
      }
      if (lookupOptions.all) return callback(null, resolved);
      const selected = resolved.find(entry => !lookupOptions.family || entry.family === lookupOptions.family)
        || resolved[0];
      return callback(null, selected.address, selected.family);
    });
  };
}

module.exports = {
  createPublicAddressLookup,
  isPublicAddress,
};
