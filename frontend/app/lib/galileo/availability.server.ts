import type { GalileoCatalog, GalileoModelOption } from '../stepModels';
import { readGalileoConfig } from './config.server';
import { resolveGalileoModelId, resolveGalileoProtocol } from './inference.server';

export function addGalileoAvailability(catalog: GalileoCatalog, environment: Record<string, string | undefined> = process.env): GalileoCatalog {
  let gateway: NonNullable<GalileoCatalog['gateway']> = { state: 'disabled' };
  if (environment.GALILEO_ENABLED === 'true') {
    try {
      const config = readGalileoConfig(environment);
      gateway = { state: 'ready', endpoint: config.baseUrl };
    } catch {
      gateway = { state: 'configuration-required' };
    }
  }
  const supported = (model: GalileoModelOption) => {
    try {
      resolveGalileoProtocol(model);
      resolveGalileoModelId(model);
      return true;
    } catch { return false; }
  };
  return {
    ...catalog, gateway,
    models: catalog.models.map(model => ({ ...model, disabled: gateway.state !== 'ready' || !supported(model) })),
  };
}