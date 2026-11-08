"use strict";
const policy = require("./dist/core/application/modeling/curve.js");
const { createCurveSource } = require("./dist/python/curve-source.js");
const { csv } = require("./data-import");
module.exports = {
  descriptors: policy.descriptors,
  validate: policy.validate,
  quantity: policy.quantity,
  prepare: policy.createCurvePreparation(createCurveSource(csv)),
};
