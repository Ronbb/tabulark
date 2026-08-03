import type { PreviewProvider } from "./types.js";

const official = Symbol("tabulark.preview.official-provider");
type InternalProvider = PreviewProvider & { readonly [official]: true };
function provider(id: string, formats: PreviewProvider["formats"], kinds: PreviewProvider["kinds"]): InternalProvider {
  return Object.freeze({ id, formats: Object.freeze([...formats]), kinds: Object.freeze([...kinds]), [official]: true as const });
}
export const structuredProvider = provider("tabulark:structured", ["json", "jsonl", "yaml", "xml", "toml"], ["structured"]);
export const textProvider = provider("tabulark:text", ["text", "markdown", "log", "ini", "env", "properties", "code"], ["text"]);
export const imageProvider = provider("tabulark:image", ["png", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic"], ["image"]);
export const officialPreviewProviders: readonly PreviewProvider[] = Object.freeze([structuredProvider, textProvider, imageProvider]);
export function isOfficialProvider(value: PreviewProvider): value is InternalProvider { return (value as Partial<InternalProvider>)[official] === true; }
