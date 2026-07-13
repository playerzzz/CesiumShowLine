// The viewer is created by Cesium.js in HelloWorld.html. Reuse that exact
// runtime here: mixing it with the ESM build creates a second ContextLimits
// singleton whose maximumTextureSize is still 0.
const Cesium = globalThis.Cesium;

if (!Cesium) {
  throw new Error("Cesium.js must be loaded before WebGLHeatmap.js.");
}

const DEFAULT_GRADIENT_SOURCE = `
vec3 getGradientColor(float value)
{
    const vec3 blue = vec3(0.1725, 0.4824, 0.7137);
    const vec3 cyan = vec3(0.0, 0.6510, 0.7922);
    const vec3 yellow = vec3(1.0, 1.0, 0.5490);
    const vec3 orange = vec3(0.9608, 0.4863, 0.0);
    const vec3 red = vec3(0.8431, 0.0980, 0.1098);

    if (value < 0.2) {
        return blue;
    }
    if (value < 0.4) {
        return mix(blue, cyan, (value - 0.2) / 0.2);
    }
    if (value < 0.6) {
        return mix(cyan, yellow, (value - 0.4) / 0.2);
    }
    if (value < 0.8) {
        return mix(yellow, orange, (value - 0.6) / 0.2);
    }
    return mix(orange, red, clamp((value - 0.8) / 0.2, 0.0, 1.0));
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    float heat = clamp(texture(heatTexture, materialInput.st).r, 0.0, 1.0);
    vec3 color = getGradientColor(heat);

    material.diffuse = color;
    material.emission = color * 0.15;
    material.alpha = smoothstep(0.01, 0.16, heat) * maxOpacity;
    return material;
}
`;

const SPLAT_VERTEX_SHADER = `
in vec2 a_center;
in vec2 a_offset;
in float a_weight;

uniform vec2 u_textureDimensions;
uniform float u_radius;

out vec2 v_offset;
out float v_weight;

void main()
{
    vec2 pixelOffset = a_offset * u_radius / u_textureDimensions;
    vec2 position = a_center + pixelOffset;

    v_offset = a_offset;
    v_weight = a_weight;
    gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPLAT_FRAGMENT_SHADER = `
in vec2 v_offset;
in float v_weight;

void main()
{
    float distanceSquared = dot(v_offset, v_offset);
    if (distanceSquared > 1.0) {
        discard;
    }

    float intensity = v_weight * exp(-4.0 * distanceSquared);
    out_FragColor = vec4(1.0, 0.0, 0.0, intensity);
}
`;

const QUAD_OFFSETS = [
  -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0,
];

class HeatmapTexturePrimitive {
  constructor(options) {
    this.show = true;
    this._textureWidth = options.textureWidth;
    this._textureHeight = options.textureHeight;
    this._textureDimensions = new Cesium.Cartesian2(
      options.textureWidth,
      options.textureHeight,
    );
    this._vertexData = createVertexData(
      options.data,
      options.bounds,
      options.maxValue,
    );
    this._getRadius = options.getRadius;
    this._onTextureCreated = options.onTextureCreated;
    this._onTextureRendered = options.onTextureRendered;
    this._radius = 0.0;
    this._dirty = true;
    this._rendered = false;
    this._destroyed = false;
    this._vertexArray = undefined;
    this._shaderProgram = undefined;
    this._texture = undefined;
    this._framebuffer = undefined;
    this._computeCommand = undefined;
  }

  update(frameState) {
    if (!this.show) {
      return;
    }

    if (!this._computeCommand) {
      this._initialize(frameState.context);
    }

    const radius = this._getRadius();
    if (Math.abs(radius - this._radius) > 0.05) {
      this._radius = radius;
      this._dirty = true;
    }

    if (this._dirty) {
      frameState.commandList.push(this._computeCommand);
      this._dirty = false;
    }
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    if (this._destroyed) {
      return undefined;
    }

    if (this._vertexArray && !this._vertexArray.isDestroyed()) {
      this._vertexArray.destroy();
    }
    if (this._shaderProgram && !this._shaderProgram.isDestroyed()) {
      this._shaderProgram.destroy();
    }
    if (this._framebuffer && !this._framebuffer.isDestroyed()) {
      this._framebuffer.destroy();
    }
    if (this._texture && !this._texture.isDestroyed()) {
      this._texture.destroy();
    }

    this._destroyed = true;
    return undefined;
  }

  _initialize(context) {
    const centerBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: this._vertexData.centers,
      usage: Cesium.BufferUsage.STATIC_DRAW,
    });
    const offsetBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: this._vertexData.offsets,
      usage: Cesium.BufferUsage.STATIC_DRAW,
    });
    const weightBuffer = Cesium.Buffer.createVertexBuffer({
      context,
      typedArray: this._vertexData.weights,
      usage: Cesium.BufferUsage.STATIC_DRAW,
    });

    this._vertexArray = new Cesium.VertexArray({
      context,
      attributes: [
        {
          index: 0,
          vertexBuffer: centerBuffer,
          componentsPerAttribute: 2,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
        {
          index: 1,
          vertexBuffer: offsetBuffer,
          componentsPerAttribute: 2,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
        {
          index: 2,
          vertexBuffer: weightBuffer,
          componentsPerAttribute: 1,
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
        },
      ],
    });

    this._shaderProgram = Cesium.ShaderProgram.fromCache({
      context,
      vertexShaderSource: SPLAT_VERTEX_SHADER,
      fragmentShaderSource: SPLAT_FRAGMENT_SHADER,
      attributeLocations: {
        a_center: 0,
        a_offset: 1,
        a_weight: 2,
      },
    });

    this._texture = new Cesium.Texture({
      context,
      width: this._textureWidth,
      height: this._textureHeight,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      sampler: new Cesium.Sampler({
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
      }),
    });

    this._framebuffer = new Cesium.Framebuffer({
      context,
      colorTextures: [this._texture],
      destroyAttachments: false,
    });

    const viewport = new Cesium.BoundingRectangle(
      0,
      0,
      this._textureWidth,
      this._textureHeight,
    );
    const clearCommand = new Cesium.ClearCommand({
      color: Cesium.Color.TRANSPARENT,
      framebuffer: this._framebuffer,
      renderState: Cesium.RenderState.fromCache({ viewport }),
    });
    const drawCommand = new Cesium.DrawCommand({
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      vertexArray: this._vertexArray,
      shaderProgram: this._shaderProgram,
      framebuffer: this._framebuffer,
      count: this._vertexData.vertexCount,
      renderState: Cesium.RenderState.fromCache({
        viewport,
        depthTest: {
          enabled: false,
        },
        depthMask: false,
        blending: Cesium.BlendingState.ADDITIVE_BLEND,
      }),
      uniformMap: {
        u_textureDimensions: () => this._textureDimensions,
        u_radius: () => this._radius,
      },
    });

    this._computeCommand = {
      owner: this,
      pass: Cesium.Pass.COMPUTE,
      execute: () => {
        clearCommand.execute(context);
        drawCommand.execute(context);
        if (!this._rendered) {
          this._rendered = true;
          this._onTextureRendered();
        }
      },
    };

    this._onTextureCreated(this._texture);
  }
}

export class WebGLHeatmap {
  constructor(viewer, options) {
    if (!viewer) {
      throw new Error("viewer is required.");
    }
    if (!Array.isArray(options?.data) || options.data.length === 0) {
      throw new Error("WebGLHeatmap requires non-empty data.");
    }
    if (!Cesium.GroundPrimitive.supportsMaterials(viewer.scene)) {
      throw new Error("当前 WebGL 环境不支持 GroundPrimitive 材质。");
    }

    this._viewer = viewer;
    this._scene = viewer.scene;
    this._destroyed = false;
    this._targetScreenRadius = options.radius ?? 28;
    this._padding = options.padding ?? 0.08;
    this._maxOpacity = options.maxOpacity ?? 0.8;
    this._bounds = getPaddedBounds(options.data, this._padding);
    this.rectangle = Cesium.Rectangle.fromDegrees(
      this._bounds.west,
      this._bounds.south,
      this._bounds.east,
      this._bounds.north,
    );

    const textureSize = getTextureSize(
      this._bounds,
      options.textureSize ?? 1024,
    );
    this._textureWidth = textureSize.width;
    this._textureHeight = textureSize.height;
    this._viewRectangle = new Cesium.Rectangle();
    this._textureRendered = false;

    let resolveReady;
    let rejectReady;
    this.readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const maxValue = Math.max(...options.data.map((item) => item.value));
    this._material = new Cesium.Material({
      fabric: {
        uniforms: {
          heatTexture: Cesium.Material.DefaultImageId,
          maxOpacity: this._maxOpacity,
        },
        source: DEFAULT_GRADIENT_SOURCE,
      },
      translucent: true,
    });

    this._texturePrimitive = this._scene.primitives.add(
      new HeatmapTexturePrimitive({
        data: options.data,
        bounds: this._bounds,
        maxValue,
        textureWidth: this._textureWidth,
        textureHeight: this._textureHeight,
        getRadius: () => this._getTextureRadius(),
        onTextureCreated: (texture) => {
          this._material.uniforms.heatTexture = texture;
        },
        onTextureRendered: () => {
          this._textureRendered = true;
        },
      }),
    );

    this._groundPrimitive = this._scene.primitives.add(
      new Cesium.GroundPrimitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.RectangleGeometry({
            rectangle: this.rectangle,
            vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
          }),
        }),
        appearance: new Cesium.EllipsoidSurfaceAppearance({
          aboveGround: false,
          material: this._material,
          translucent: true,
        }),
        classificationType: Cesium.ClassificationType.TERRAIN,
      }),
    );

    this._removeAfterRender = this._scene.postRender.addEventListener(() => {
      if (this._textureRendered && this._groundPrimitive.ready) {
        this._removeReadyListeners();
        resolveReady(this);
      }
    });
    this._removeRenderError = this._scene.renderError.addEventListener(
      (_scene, error) => {
        this._removeReadyListeners();
        rejectReady(error);
      },
    );
  }

  isDestroyed() {
    return this._destroyed;
  }

  destroy() {
    if (this._destroyed) {
      return undefined;
    }

    this._scene.primitives.remove(this._groundPrimitive);
    this._scene.primitives.remove(this._texturePrimitive);
    this._removeReadyListeners();
    this._destroyed = true;
    return undefined;
  }

  _getTextureRadius() {
    const viewRectangle = this._viewer.camera.computeViewRectangle(
      this._scene.globe.ellipsoid,
      this._viewRectangle,
    );
    if (!viewRectangle) {
      return 28;
    }

    let visibleWidth = viewRectangle.east - viewRectangle.west;
    if (visibleWidth < 0) {
      visibleWidth += Cesium.Math.TWO_PI;
    }

    const visibleWidthInDegrees = Cesium.Math.toDegrees(visibleWidth);
    const dataWidthInDegrees = this._bounds.east - this._bounds.west;
    const viewportWidth = Math.max(this._viewer.canvas.clientWidth, 1);
    const radius =
      this._targetScreenRadius *
      (visibleWidthInDegrees / dataWidthInDegrees) *
      (this._textureWidth / viewportWidth);

    return Cesium.Math.clamp(radius, 4, 220);
  }

  _removeReadyListeners() {
    if (this._removeAfterRender) {
      this._removeAfterRender();
      this._removeAfterRender = undefined;
    }
    if (this._removeRenderError) {
      this._removeRenderError();
      this._removeRenderError = undefined;
    }
  }
}

function createVertexData(data, bounds, maxValue) {
  const verticesPerPoint = 6;
  const vertexCount = data.length * verticesPerPoint;
  const centers = new Float32Array(vertexCount * 2);
  const offsets = new Float32Array(vertexCount * 2);
  const weights = new Float32Array(vertexCount);
  const longitudeRange = bounds.east - bounds.west;
  const latitudeRange = bounds.north - bounds.south;

  for (let pointIndex = 0; pointIndex < data.length; pointIndex++) {
    const point = data[pointIndex];
    const u = (point.lng - bounds.west) / longitudeRange;
    const v = (point.lat - bounds.south) / latitudeRange;
    const weight = Cesium.Math.clamp(point.value / maxValue, 0, 1);

    for (let vertexIndex = 0; vertexIndex < verticesPerPoint; vertexIndex++) {
      const destinationIndex = pointIndex * verticesPerPoint + vertexIndex;
      centers[destinationIndex * 2] = u;
      centers[destinationIndex * 2 + 1] = v;
      offsets[destinationIndex * 2] = QUAD_OFFSETS[vertexIndex * 2];
      offsets[destinationIndex * 2 + 1] = QUAD_OFFSETS[vertexIndex * 2 + 1];
      weights[destinationIndex] = weight;
    }
  }

  return {
    centers,
    offsets,
    weights,
    vertexCount,
  };
}

function getPaddedBounds(data, paddingRatio) {
  const lngs = data.map((item) => item.lng);
  const lats = data.map((item) => item.lat);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const lngPadding = Math.max((east - west) * paddingRatio, 0.01);
  const latPadding = Math.max((north - south) * paddingRatio, 0.01);

  return {
    west: west - lngPadding,
    east: east + lngPadding,
    south: south - latPadding,
    north: north + latPadding,
  };
}

function getTextureSize(bounds, maxSize) {
  const middleLatitude = (bounds.south + bounds.north) / 2;
  const widthInDegrees =
    (bounds.east - bounds.west) *
    Math.cos(Cesium.Math.toRadians(middleLatitude));
  const heightInDegrees = bounds.north - bounds.south;
  const aspectRatio = widthInDegrees / heightInDegrees;

  if (aspectRatio >= 1) {
    return {
      width: maxSize,
      height: Math.max(256, Math.round(maxSize / aspectRatio)),
    };
  }

  return {
    width: Math.max(256, Math.round(maxSize * aspectRatio)),
    height: maxSize,
  };
}
