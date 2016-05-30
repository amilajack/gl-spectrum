/**
 * @module  gl-spectrum
 */

var extend = require('xtend/mutable');
var Component = require('gl-component');
var inherits = require('inherits');
var lg = require('mumath/lg');
var isBrowser = require('is-browser');
var createGrid = require('plot-grid');
var colormap = require('colormap');
var flatten = require('flatten');
var clamp = require('mumath/clamp');
var weighting = require('a-weighting');

module.exports = Spectrum;



/**
 * @contructor
 */
function Spectrum (options) {
	if (!(this instanceof Spectrum)) return new Spectrum(options);

	var that = this;

	options = options || {};

	Component.call(this, options);

	if (isBrowser) {
		this.container.classList.add('gl-spectrum');
	}

	if (!this.is2d) {
		var gl = this.gl;

		var float = gl.getExtension('OES_texture_float');
		if (!float) throw Error('WebGL does not support floats.');
		var floatLinear = gl.getExtension('OES_texture_float_linear');
		if (!floatLinear) throw Error('WebGL does not support floats.');

		//setup alpha
		gl.enable( gl.BLEND );
		gl.blendEquation( gl.FUNC_ADD );
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

		this.maskSizeLocation = gl.getUniformLocation(this.program, 'maskSize');
		this.alignLocation = gl.getUniformLocation(this.program, 'align');
		this.minFrequencyLocation = gl.getUniformLocation(this.program, 'minFrequency');
		this.maxFrequencyLocation = gl.getUniformLocation(this.program, 'maxFrequency');
		this.logarithmicLocation = gl.getUniformLocation(this.program, 'logarithmic');
		this.sampleRateLocation = gl.getUniformLocation(this.program, 'sampleRate');
		this.groupLocation = gl.getUniformLocation(this.program, 'group');

		this.bgComponent = new Component({
			frag: `
			precision lowp float;
			uniform sampler2D background;
			uniform vec4 viewport;
			void main() {
				vec2 coord = (gl_FragCoord.xy - viewport.xy) / (viewport.zw);
				gl_FragColor = texture2D(background, coord);
			}`,
			viewport: () => this.viewport,
			context: this.context,
			autostart: false
		});
	}

	this.on('resize', () => {
		this.recalc();
	});

	this.update();
}

inherits(Spectrum, Component);


Spectrum.prototype.antialias = true;
Spectrum.prototype.premultipliedAlpha = true;
Spectrum.prototype.alpha = false;


Spectrum.prototype.maxDecibels = -30;
Spectrum.prototype.minDecibels = -100;

Spectrum.prototype.maxFrequency = 20000;
Spectrum.prototype.minFrequency = 20;

Spectrum.prototype.smoothing = 0.5;
Spectrum.prototype.details = 1;

Spectrum.prototype.snap = null;

Spectrum.prototype.grid = true;
Spectrum.prototype.axes = false;

Spectrum.prototype.logarithmic = true;

Spectrum.prototype.weighting = 'itu';

//evenly distributed within indicated diapasone
Spectrum.prototype.frequencies = new Float32Array(512).fill(Spectrum.prototype.minDecibels);


//TODO
Spectrum.prototype.orientation = 'horizontal';

//required to detect frequency resolution
Spectrum.prototype.sampleRate = 44100;

//colors to map spectrum against
Spectrum.prototype.fill = 'greys';
Spectrum.prototype.background = undefined;

//amount of alignment
Spectrum.prototype.align = .0;

//TODO implement shadow frequencies, like averaged/max values
Spectrum.prototype.shadow = [];

//mask defines style of bars, dots or line
Spectrum.prototype.mask = null;

//group freq range by subbands
Spectrum.prototype.group = false;

//scale verteces to frequencies values and apply alignment
Spectrum.prototype.vert = `
	precision lowp float;

	attribute vec2 position;

	uniform sampler2D frequencies;
	uniform sampler2D mask;
	uniform vec2 maskSize;
	uniform float align;
	uniform float minFrequency;
	uniform float maxFrequency;
	uniform float logarithmic;
	uniform float sampleRate;
	uniform vec4 viewport;
	uniform float group;

	varying float vDist;
	varying float vMag;
	varying float vLeft;
	varying float vRight;

	const float log10 = ${Math.log(10)};

	float lg (float x) {
		return log(x) / log10;
	}

	//return a or b based on weight
	float decide (float a, float b, float w) {
		return step(0.5, w) * b + step(w, 0.5) * a;
	}

	//get mapped frequency
	float f (float ratio) {
		float halfRate = sampleRate * .5;

		float logF = pow(10., lg(minFrequency) + ratio * (lg(maxFrequency) - lg(minFrequency)) );

		ratio = decide(ratio, (logF - minFrequency) / (maxFrequency - minFrequency), logarithmic);

		float leftF = minFrequency / halfRate;
		float rightF = maxFrequency / halfRate;

		ratio = leftF + ratio * (rightF - leftF);

		return ratio;
	}

	void main () {
		vec2 coord = position;
		float _group = max(group, .5);
		float groupRatio = _group / viewport.z;

		//round x-coord to the step, @c is a precision fix constant
		float c = .001;
		float leftX = floor((coord.x * viewport.z + c ) / _group) * _group / viewport.z;
		float rightX = ceil((coord.x * viewport.z + c ) / _group) * _group / viewport.z;
		coord.x = decide(leftX, rightX, step(coord.x - leftX + c*.5, groupRatio * .5));

		float mag = texture2D(frequencies, vec2(f(leftX), 0.5)).w;
		mag = clamp(mag, 0., 1.);

		vMag = mag;
		vLeft = leftX;
		vRight = rightX;

		//ensure mask borders are set
		mag += maskSize.y / viewport.w;

		//map y-coord to alignment
		coord.y = coord.y * mag - mag * align + align;

		//save distance from the align
		vDist = (coord.y - align) * (1. / max(align, 1. - align));

		gl_Position = vec4(coord*2. - 1., 0, 1);
	}
`;

Spectrum.prototype.frag = `
	precision lowp float;

	uniform sampler2D fill;
	uniform sampler2D mask;
	uniform vec2 maskSize;
	uniform vec4 viewport;
	uniform float align;
	uniform float group;

	varying float vDist;
	varying float vMag;
	varying float vLeft;
	varying float vRight;

	vec2 coord;
	vec2 bin;

	float decide (float a, float b, float w) {
		return step(0.5, w) * b + step(w, 0.5) * a;
	}

	void main () {
		coord = (gl_FragCoord.xy - viewport.xy) / (viewport.zw);
		bin = vec2(1. / viewport.zw);
		float groupRatio = group / viewport.z;
		float maskRatio = maskSize.x / viewport.z;

		//calc mask
		float halfX = min(group * .5 / maskSize.x, .5);
		float leftX = (coord.x - vLeft) * viewport.z / maskSize.x;
		float leftPart = step(leftX, halfX) * step(0., leftX);
		float rightX = 1. - ((vRight - coord.x) * viewport.z) / maskSize.x;
		float rightPart = step(rightX, 1.) * step(1. - halfX, rightX);
		float centralPart = 1. - leftPart - rightPart;

		float maskX = decide(.5, centralPart * .5 + leftPart * leftX + rightPart * rightX, step(2., group));

		//find mask’s offset frequency
		float mag = vMag;

		//calc dist
		float dist = abs(vDist);

		//calc intensity
		float maxAlign = min(max(align, 1. - align), .85);
		float minAlign = max(1. - maxAlign, .15);
		float intensity = (1. - pow((1. - dist), .85)) * maxAlign + minAlign;

		//apply mask
		float top = coord.y - mag + align*mag - align + .5*maskSize.y/viewport.w;
		float bottom = -coord.y - align*mag + align + .5*maskSize.y/viewport.w;
		float maskY = max(
			max(top * viewport.w / maskSize.y, .5),
			max(bottom * viewport.w / maskSize.y, .5)
		);
		vec2 maskCoord = vec2(maskX, maskY);
		float maskLevel = texture2D(mask, maskCoord).x;

		// gl_FragColor = vec4(vec3(maskX), 1);
		vec4 fillColor = texture2D(fill, vec2(coord.x, max(0., intensity)));
		fillColor.a *= maskLevel;
		gl_FragColor = fillColor;
	}
`;


/**
 * Set frequencies taking into account smoothing, logarithmic and grouping params
 */
Spectrum.prototype.setFrequencies = function (frequencies) {
	if (!frequencies) return this;

	var gl = this.gl;
	var minF = this.minFrequency, maxF = this.maxFrequency;
	var minDb = this.minDecibels, maxDb = this.maxDecibels;
	var halfRate = this.sampleRate * 0.5;
	var l = halfRate / this.frequencies.length;

	//choose bigger data
	var bigger = this.frequencies.length >= frequencies.length ? this.frequencies : frequencies;
	var shorter = bigger === frequencies ? this.frequencies : frequencies;

	var smoothing = bigger === this.frequencies ? this.smoothing : 1 - this.smoothing;


	for (var i = 0; i < bigger.length; i++) {
		bigger[i] = clamp(bigger[i], -200, 0) * smoothing + clamp(shorter[Math.floor(shorter.length * (i / bigger.length))], -200, 0) * (1 - smoothing);
	}

	//save actual frequencies
	this.frequencies = bigger;

	//prepare f’s for rendering
	magnitudes = bigger.slice();

	//apply a-weighting
	if (weighting[this.weighting]) {
		var w = weighting[this.weighting];
		magnitudes = magnitudes.map((mag, i, data) => clamp(mag + 20 * Math.log(w(i * l)) / Math.log(10), -100, 0));
	}

	//snap magnitudes
	if (this.snap) {
		magnitudes = magnitudes.map((value) => Math.round(value * this.snap) / this.snap);
	}

	//convert mags to 0..1 range limiting by db subrange
	magnitudes = magnitudes.map((value) => (value - minDb) / (maxDb - minDb));


	return this.setTexture('frequencies', {
		data: magnitudes,
		format: gl.ALPHA,
		magFilter: this.gl.LINEAR,
		minFilter: this.gl.LINEAR,
		wrap: this.gl.CLAMP_TO_EDGE
	});
};


/**
 * Recalculate number of verteces
 */
Spectrum.prototype.recalc = function () {
	var data = [], w = this.viewport[2] * this.details;

	//no-grouping is simply connected points
	if (!this.group || this.group <= .5) {
		for (var i = 0; i < w; i++) {
			var curr = i/w;
			var next = (i+1)/w;
			data.push(curr);
			data.push(1);
			data.push(next);
			data.push(1);
			data.push(curr);
			data.push(0);
			data.push(next);
			data.push(0);
		}
	}
	//grouping renders bars
	else {
		var size = this.group === true ? 1 : this.group;
		var w = w / size;
		for (var i = 0; i < w; i++) {
			var curr = i/(w);
			var next = (i+.5)/(w);
			data.push(curr);
			data.push(1);
			data.push(curr);
			data.push(1);
			data.push(curr);
			data.push(1);
			data.push(next);
			data.push(1);
			data.push(curr);
			data.push(0);
			data.push(next);
			data.push(0);
			data.push(next);
			data.push(0);
			data.push(next);
			data.push(0);
		}
	}

	this.setAttribute('position', data);

	return this;
};


/**
 * Reset colormap
 */
Spectrum.prototype.setFill = function (cm, inverse) {
	//named colormap
	if (typeof cm === 'string') {
		this.fill = (flatten(colormap({
			colormap: cm,
			nshades: 128,
			format: 'rgba',
			alpha: 1
		})).map((v,i) => !((i + 1) % 4) ? v : v/255));
	}
	//custom array
	else {
		this.fill = (flatten(cm));
	}

	if (inverse) {
		var reverse = this.fill.slice();
		for (var i = 0; i < this.fill.length; i+=4){
			reverse[this.fill.length - i - 1] = this.fill[i + 3];
			reverse[this.fill.length - i - 2] = this.fill[i + 2];
			reverse[this.fill.length - i - 3] = this.fill[i + 1];
			reverse[this.fill.length - i - 4] = this.fill[i + 0];
		}
		this.fill = reverse;
	}

	this.setTexture('fill', {
		data: this.fill,
		width: 1,
		height: (this.fill.length / 4)|0,
		format: this.gl.RGBA,
		magFilter: this.gl.LINEAR,
		minFilter: this.gl.LINEAR,
		wrap: this.gl.CLAMP_TO_EDGE
	});

	//ensure bg
	if (!this.background) {
		this.setBackground(this.fill.slice(0, 4));
	}

	//set grid color to colormap’s color
	if (this.freqGridComponent) {
		var gridColor = this.fill.slice(-4).map((v) => v*255);
		this.freqGridComponent.linesContainer.style.color = `rgba(${gridColor})`;
		this.topGridComponent.linesContainer.style.color = `rgba(${gridColor})`;
		this.bottomGridComponent.linesContainer.style.color = `rgba(${gridColor})`;
	}

	return this;
};


/** Set background */
Spectrum.prototype.setBackground = function (bg) {
	if (this.background !== null) {
		this.bgComponent && this.bgComponent.setTexture('background', {
			data: bg,
			format: this.gl.RGBA,
			magFilter: this.gl.LINEAR,
			minFilter: this.gl.LINEAR,
			wrap: this.gl.CLAMP_TO_EDGE
		});
	}

	return this;
};


/**
 * Set named or array mask
 */
Spectrum.prototype.setMask = function (mask) {
	this.mask = mask || [1,1,1,1];

	this.setTexture('mask', {
		data: this.mask,
		type: this.gl.FLOAT,
		format: this.gl.LUMINOCITY,
		wrap: this.gl.CLAMP_TO_EDGE
	});

	this.gl.uniform2f(this.maskSizeLocation, this.textures.mask.width, this.textures.mask.height);

	return this;
};


/**
 * Update uniforms values, textures etc.
 * It should be called when the settings changed.
 */
Spectrum.prototype.update = function () {
	var gl = this.gl;

	//create grid, if not created yet
	if (this.grid) {
		if (!this.freqGridComponent) {
			this.freqGridComponent = createGrid({
				container: this.container,
				viewport: () => this.viewport,
				lines: Array.isArray(this.grid.lines) ? this.grid.lines : (this.grid.lines === undefined || this.grid.lines === true) && [{
					min: this.minFrequency,
					max: this.maxFrequency,
					orientation: 'x',
					logarithmic: this.logarithmic,
					titles: function (value) {
						return (value >= 1000 ? ((value / 1000).toLocaleString() + 'k') : value.toLocaleString()) + 'Hz';
					}
				}, this.logarithmic ? {
					min: this.minFrequency,
					max: this.maxFrequency,
					orientation: 'x',
					logarithmic: this.logarithmic,
					values: function (value) {
						var str = value.toString();
						if (str[0] !== '1') return null;
						return value;
					},
					titles: null,
					style: {
						borderLeftStyle: 'solid',
						pointerEvents: 'none',
						opacity: '0.08',
						display: this.logarithmic ? null :'none'
					}
				} : null],
				axes: Array.isArray(this.grid.axes) ? this.grid.axes : (this.grid.axes || this.axes) && [{
					name: 'Frequency',
					labels: function (value, i, opt) {
						var str = value.toString();
						if (str[0] !== '2' && str[0] !== '1' && str[0] !== '5') return null;
						return opt.titles[i];
					}
				}]
			});

			this.topGridComponent = createGrid({
				container: this.container,
				viewport: () => [
					this.viewport[0],
					this.viewport[1],
					this.viewport[2],
					this.viewport[3] * (1 - this.align)
				],
				lines: [{
					min: this.minDecibels,
					max: this.maxDecibels,
					orientation: 'y',
					titles: function (value) {
						return value.toLocaleString() + 'dB';
					}
				}],
				axes: Array.isArray(this.grid.axes) ? this.grid.axes : (this.grid.axes || this.axes) && [{
					name: 'Magnitude'
				}]
			});

			//alignment requires additional grid
			this.bottomGridComponent = createGrid({
				container: this.container,
				viewport: () => [
					this.viewport[0],
					this.viewport[1] + this.viewport[3] * (1 - this.align),
					this.viewport[2],
					this.viewport[3] * this.align
				],
				lines: [{
					min: this.maxDecibels,
					max: this.minDecibels,
					orientation: 'y',
					titles: function (value) {
						return value.toLocaleString() + 'dB';
					}
				}],
				axes: Array.isArray(this.grid.axes) ? this.grid.axes : (this.grid.axes || this.axes) && [{
					name: 'Magnitude'
				}]
			});

			this.on('resize', () => {
				if (this.isPlannedGridUpdate) return;
				this.isPlannedGridUpdate = true;
				this.once('render', () => {
					this.isPlannedGridUpdate = false;
					this.topGridComponent.update();
					this.bottomGridComponent.update();
					this.freqGridComponent.update();
				});
			});
		} else {
			this.freqGridComponent.linesContainer.style.display = 'block';
			this.topGridComponent.linesContainer.style.display = 'block';
			this.bottomGridComponent.linesContainer.style.display = 'block';

			this.topGridComponent.update();
			this.bottomGridComponent.update();

			this.freqGridComponent.update({
				lines: [{
						logarithmic: this.logarithmic
					}, {
						logarithmic: this.logarithmic,
						style: {
							display: this.logarithmic ? null : 'none'
						}
					}
				]
			});
		}

	}
	else if (this.freqGridComponent) {
		this.freqGridComponent.linesContainer.style.display = 'none';
		this.topGridComponent.linesContainer.style.display = 'none';
		this.bottomGridComponent.linesContainer.style.display = 'none';
	}

	//update verteces
	this.recalc();

	//update textures
	this.setBackground(this.background);
	this.setFrequencies(this.frequencies);
	this.setFill(this.fill);
	this.setMask(this.mask);

	this.gl.uniform1f(this.alignLocation, this.align);
	this.gl.uniform1f(this.minFrequencyLocation, this.minFrequency);
	this.gl.uniform1f(this.maxFrequencyLocation, this.maxFrequency);
	this.gl.uniform1f(this.logarithmicLocation, this.logarithmic ? 1 : 0);
	this.gl.uniform1f(this.sampleRateLocation, this.sampleRate);
	this.gl.uniform1f(this.groupLocation, this.group || 0);

	return this;
};


/**
 * Render main loop
 */
Spectrum.prototype.draw = function () {
	var gl = this.gl;

	this.bgComponent.render();

	gl.useProgram(this.program);

	var count = this.attributes.position.data.length / 2;

	if (this.group) {
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.attributes.position.data.length / 2);
		gl.drawArrays(gl.LINES, 0, this.attributes.position.data.length / 2 - 0);
	}
	else {
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.attributes.position.data.length / 2);
		gl.drawArrays(gl.LINES, 0, this.attributes.position.data.length / 2);
	}

	// if (this.trail) {
	// 	gl.drawElements(gl.LINES, count, gl.UNSIGNED_SHORT, 0);
	// }

	return this;
};
