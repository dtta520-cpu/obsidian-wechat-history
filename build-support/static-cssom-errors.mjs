// Keep CSSOM's standard error types without dynamically evaluating a string.
// The package's MIT license is included by the regular bundle-notice step.
export function staticCssomErrors(source) {
  const fallback = 'eval(errorType)';
  if (source.split(fallback).length !== 2) throw new Error('CSSOM error fallback changed; inspect the dependency before building.');
  return source.replace(fallback, '({ Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, DOMException: typeof DOMException === "undefined" ? Error : DOMException }[errorType] || Error)');
}
