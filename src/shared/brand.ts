// The product's name and logo, in one place: renaming the app is this file, package.json's "build.productName" and
// "build.appId" staying as they are, and the files in assets/.

export const APP_NAME = 'Claude Hub';
/** Window and taskbar identity (Windows AppUserModelID); equals package.json "build.appId". Stable across renames. */
export const APP_ID = 'io.github.anilito1.hub';
/** Logo shown in the title bar, copied next to the page by build.mjs from assets/logo.png. */
export const LOGO = 'logo.png';
