'use strict';

const SHOP_ENTRY_ID_PATTERN = /^[A-Z][A-Z0-9_]{1,63}_SHOP_[A-Za-z0-9_-]+$/;

function isOwnedShopEntryId(entryId) {
  return typeof entryId === 'string' && SHOP_ENTRY_ID_PATTERN.test(entryId);
}

module.exports = {
  isOwnedShopEntryId,
};
