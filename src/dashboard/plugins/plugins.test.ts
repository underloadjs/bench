// dashboard/plugins/plugins.test.ts — exact-value tests for the fleet wiring.
//
// Covers the catalog → plugin-factory conversion contract introduced with the
// rail sorting/labeling change:
//   - stripModelPrefix: "modal/kimi-k3" → "kimi-k3" (bare ids unchanged)
//   - modelDisplayName: "modal/kimi-k3" → "kimi-k3 (modal)" (bare ids unchanged)
//   - catalogToPluginFactories sorts by the STRIPPED name (org prefixes must
//     not influence rail order) while spec.id keeps the FULL routing key and
//     the display label flows through to the loaded plugin.
import { describe, expect, it } from 'vitest';
import { BENCH_FRAMEWORK } from '../framework';
import { catalogToPluginFactories, modelDisplayName, stripModelPrefix } from './index';

describe('stripModelPrefix', () => {
    it('strips the organisation/provider prefix at the LAST slash', () => {
        expect(stripModelPrefix('modal/kimi-k3')).toBe('kimi-k3');
        expect(stripModelPrefix('zai-org/GLM-5.3-NVFP4')).toBe('GLM-5.3-NVFP4');
        // Deep nesting: only the final segment is the model name
        expect(stripModelPrefix('a/b/model-x')).toBe('model-x');
    });

    it('passes bare ids through unchanged', () => {
        expect(stripModelPrefix('glm-5.2')).toBe('glm-5.2');
        expect(stripModelPrefix('qwen3.8-27b')).toBe('qwen3.8-27b');
    });
});

describe('modelDisplayName', () => {
    it('renders prefixed ids as "name (org)"', () => {
        expect(modelDisplayName('modal/kimi-k3')).toBe('kimi-k3 (modal)');
        expect(modelDisplayName('vultr/glm-5.3-flash')).toBe('glm-5.3-flash (vultr)');
        expect(modelDisplayName('a/b/model-x')).toBe('model-x (a/b)');
    });

    it('renders bare ids unchanged', () => {
        expect(modelDisplayName('glm-5.2')).toBe('glm-5.2');
    });
});

describe('catalogToPluginFactories', () => {
    // Invokes a factory through the real framework bundle so the test asserts
    // what the dashboard ACTUALLY loads (id/label/name), not just wiring.
    const loadFleet = (ids: string[]) =>
        catalogToPluginFactories(ids.map((id) => ({ id }))).map((factory) => {
            const plugin = factory(BENCH_FRAMEWORK);
            return { id: plugin.id, name: plugin.name, railLabel: plugin.entries[0]?.label };
        });

    it('sorts by the stripped model name, not the raw org-prefixed id', () => {
        // Raw id order would interleave provider prefixes; stripped order is
        // alphabetical by model name (glm < gpt < kimi < qwen per
        // localeCompare), independent of the org prefixes.
        const fleet = loadFleet(['zai-org/glm-5.2', 'modal/kimi-k3', 'deep-infra/qwen3.8-27b', 'openai/gpt-x']);

        expect(fleet.map((entry) => entry.id)).toEqual(['zai-org/glm-5.2', 'openai/gpt-x', 'modal/kimi-k3', 'deep-infra/qwen3.8-27b']);
    });

    it('lists the same base model from several providers adjacently', () => {
        // alpha < kimi-k3 — and the two kimi-k3 providers land adjacent,
        // keeping catalog order between themselves (stable sort).
        const fleet = loadFleet(['merge/kimi-k3', 'modal/alpha', 'modal/kimi-k3']);

        expect(fleet.map((entry) => entry.id)).toEqual(['modal/alpha', 'merge/kimi-k3', 'modal/kimi-k3']);
    });

    it('keeps the full id as the routing key and shows the shortened label', () => {
        const [only] = loadFleet(['modal/kimi-k3']);

        // Registry key + React key + completion routing key = FULL catalog id
        expect(only.id).toBe('modal/kimi-k3');
        // Rail label = "name (org)" display form; plugin name derives from it
        expect(only.railLabel).toBe('kimi-k3 (modal)');
        expect(only.name).toBe('kimi-k3 (modal) Bench');
    });

    it('does not mutate the caller-provided catalog array', () => {
        const models = [{ id: 'modal/kimi-k3' }, { id: 'aegis/alpha' }];
        const snapshot = [...models];
        catalogToPluginFactories(models);
        expect(models).toEqual(snapshot);
    });
});
