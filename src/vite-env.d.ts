/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_PORT: string;
    readonly VITE_HOST: string;
    readonly VITE_MODEL_PATH: string;
    readonly VITE_HDR_PATH: string;
    readonly VITE_DEBUG: string;
    readonly VITE_CAMERA_DEBUG: string;
    readonly VITE_MAX_PIXEL_RATIO: string;
    readonly VITE_ENABLE_SHADOWS: string;
    readonly VITE_ASSET_VERSION: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

// Audio file imports
declare module '*.mp3?url' {
    const src: string;
    export default src;
}

declare module '*.mp3' {
    const src: string;
    export default src;
}
