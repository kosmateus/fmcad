// Transitional facade. Composition stages the strict TS implementation here;
// consumers never resolve a private workspace or load TypeScript at runtime.
module.exports = {
  ...require('./dist/python/artifact'),
  ...require('./dist/python/bundle'),
  ...require('./dist/python/source-units'),
  ...require('./dist/python/checker'),
  ...require('./dist/python/admission'),
  ...require('./dist/python/context-binding'),
};
