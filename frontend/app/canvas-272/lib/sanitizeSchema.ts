import { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';

// Sanitize schema for assembled output that may embed generated images as
// `data:image/...` URLs. It widens ONLY `img` src to allow the `data` protocol;
// `href`/`cite`/`longDesc` keep the default http(s)/mailto set, so `data:` links
// are still stripped. The default schema disallows `iframe`/`object`, so there
// is no HTML sink for a `data:text/html` payload even though `data` is allowed
// on `src` (which only feeds `<img>`).
export const imageDataSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
};
