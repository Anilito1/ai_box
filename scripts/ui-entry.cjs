// Isolated UI tests never need credentials. Disable safeStorage before loading app code: newer Electron async
// storage APIs may still initialize the OS keychain despite Chromium's --use-mock-keychain switch.
const { safeStorage } = require('electron');
safeStorage.isAsyncEncryptionAvailable = async () => false;
safeStorage.isEncryptionAvailable = () => false;
const forbidden = () => { throw new Error('Secure storage is disabled in isolated UI tests'); };
safeStorage.encryptString = forbidden;
safeStorage.decryptString = forbidden;
safeStorage.encryptStringAsync = async () => forbidden();
safeStorage.decryptStringAsync = async () => forbidden();
void import('../dist/main.mjs');
