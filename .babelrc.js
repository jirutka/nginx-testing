'use strict'

/** @type {babel.TransformOptions} */
module.exports = {
  presets: [
    // Parse TypeScript syntax and transform it to JavaScript (i.e. it strips
    // type annotations, but does not perform type checking).
    ['@babel/preset-typescript', {
      allowDeclareFields: true,
    }],
  ],
  plugins: [
    // Transform ES modules to CommonJS.
    '@babel/plugin-transform-modules-commonjs',
    // Transform power-assert.
    'babel-plugin-empower-assert',
    'babel-plugin-espower',
  ],
}
