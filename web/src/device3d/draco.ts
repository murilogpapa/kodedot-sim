/**
 * Draco geometry decoder for model files that need it.
 *
 * The decoder is the open-source one shipped inside the three.js package
 * (examples/jsm/libs/draco). DRACOLoader refers to those files relative to its
 * own module, so the build copies them into the site's assets (same origin,
 * content-hashed) by itself; nothing is fetched until a Draco-compressed file
 * is actually decoded. Decoding runs in a worker made from a blob, which fits
 * the page's Content-Security-Policy as it stands (script-src 'self' blob:
 * 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self' blob:).
 */
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export function makeDracoLoader(): DRACOLoader {
  const loader = new DRACOLoader();
  loader.setWorkerLimit(2);
  return loader;
}
