/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  // onnxruntime-node checks `instanceof Float32Array`; Jest's default VM isolates typed arrays.
  testEnvironment: 'jest-environment-node-single-context',
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          moduleResolution: 'node',
        },
      },
    ],
  },
};
