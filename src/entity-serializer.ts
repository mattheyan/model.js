import { isEntityType, Type } from "./type";
import { Entity, EntityConstructorForType } from "./entity";
import { Property } from "./property";
import { ObjectLookup, flatMap } from "./helpers";
import { InitializationContext } from "./initilization-context";

export type AsyncValueResolver = (instance: Entity, property: Property, value: any) => Promise<any> | void;

export interface PropertySerializationResult {
	key: string;
	value: any;
}

export const IgnoreProperty: PropertySerializationResult = {
	key: "ignore",
	value: "ignore"
};

/**
 * Allows additional key/value pairs to be introduced to serialization output.
 * Note: duplicate keys will favor model properties.
 */
export interface PropertyInjector {
	inject(entity: Entity): PropertySerializationResult[];
}

/**
 * Allows transformation of the serialized name and value of a model property.
 */
export class PropertyConverter {
	/**
	 * @param context The `Entity` containing the specified property.
	 * @param prop The property being serialized/deserialized.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	shouldConvert(context: Entity, prop: Property): boolean {
		return true;
	}
	/**
	 * Return `IgnoreProperty` to prevent serialization of the property.
	 * @param context The `Entity` containing the specified property.
	 * @param prop The current property being serialized.
	 * @param value The value of the property on the entity currently being serialized.
	 */
	serialize(context: Entity, value: any, property: Property, settings: SerializationSettings): PropertySerializationResult {
		const result = { key: property.name, value };
		if (value) {
			if (isEntityType(property.propertyType)) {
				if (property.isList && Array.isArray(value))
					result.value = value.map((ent: Entity) => ent.serialize(settings));
				else
					result.value = value.serialize(settings);
			}
			else if (property.isList)
				result.value = value.slice();
		}
		return result;
	}
	/**
	 * Return `IgnoreProperty` to prevent deserialization of the property.
	 * @param context The `Entity` containing the specified property.
	 * @param prop The current property being deserialized.
	 * @param value The value to deserialize.
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	deserialize(context: Entity, value: any, property: Property): any {
		return value;
	}
}

export type SerializationSettings = {
	// Controls whether or not to serialize properties using their alias instead of the model property name.
	useAliases?: boolean;
	// Controls whether or not a property will be serialized even if a converter indicated it should be ignored.
	force?: boolean;
};

export const DefaultSerializationSettings: SerializationSettings = {
	force: false,
	useAliases: false
};

export class EntitySerializer {
	private _propertyConverters: PropertyConverter[] = [];
	private _propertyInjectors = new Map<Type | string, PropertyInjector[]>();
	private _propertyAliases = new Map<Type | string, ObjectLookup<string>>();
	private _valueResolvers: AsyncValueResolver[] = [];
	private static defaultPropertyConverter = new PropertyConverter();

	/**
	 * Property converters should be registered in order of increasing specificity.
	 * If two converters would convert a property, only the one registered last will apply.
	 */
	registerPropertyConverter(converter: PropertyConverter): void {
		this._propertyConverters.unshift(converter);
	}

	/**
	 * Property injections will occur when serializing entities of the specified type, or entities which
	 * inherit from the specified type. Injected properties will appear before model properties in the serialized
	 * output.
	 * @param type Either a Type or the fullName of a Type
	 * @param injector
	 */
	registerPropertyInjector(type: Type | string, injector: PropertyInjector): void {
		let injectors = this._propertyInjectors.get(type) || [];
		injectors.push(injector);
		this._propertyInjectors.set(type, injectors);
	}

	registerPropertyAlias(type: Type | string, alias: string, propertyName: string) {
		let aliases = this._propertyAliases.get(type) || {};
		aliases[alias] = propertyName;
		aliases[propertyName] = alias;
		this._propertyAliases.set(type, aliases);
	}

	registerValueResolver(resolver: AsyncValueResolver) {
		this._valueResolvers.push(resolver);
	}

	/**
	 * Returns the property injectors registered for a specific type, including name-based registrations.
	 * @param type
	 */
	private getInjectorsOrDefault(type: Type): PropertyInjector[] {
		return (this._propertyInjectors.get(type) || []).concat(this._propertyInjectors.get(type.fullName) || []);
	}

	/**
	 * Returns property injectors registered for a type and its base types.
	 * @param type
	 */
	private getPropertyInjectors(type: Type): PropertyInjector[] {
		let injectors = [];
		do {
			injectors.push(...this.getInjectorsOrDefault(type));
			type = type.baseType;
		} while (type);
		return injectors;
	}

	serializePropertyValue(entity: Entity, property: Property, value: any, settings: SerializationSettings): PropertySerializationResult {
		let converters = this._propertyConverters.filter(c => c.shouldConvert(entity, property));
		const result = (() => {
			if (converters) {
				for (const converter of converters) {
					const res = converter.serialize(entity, value, property, settings);
					if (!settings.force || res !== IgnoreProperty)
						return res;
				}
			}
			return EntitySerializer.defaultPropertyConverter.serialize(entity, value, property, settings);
		})();

		if (result && result !== IgnoreProperty && settings.useAliases)
			result.key = this.getPropertyAliases(property.containingType)[property.name] || result.key;

		return result;
	}

	/**
	 * Produces a JSON-valid object representation of the entity.
	 * @param entity
	 */
	serialize(entity: Entity, settings: SerializationSettings = DefaultSerializationSettings): object {
		let result: object = {};
		const type = entity.meta.type;
		flatMap(this.getPropertyInjectors(type), i => i.inject(entity))
			.concat(type.properties
				.filter(p => !p.isCalculated && !p.isConstant)
				.map(prop => this.serializePropertyValue(entity, prop, prop.value(entity), settings)))
			.forEach(pair => {
				if (pair && pair !== IgnoreProperty) {
					if (result.hasOwnProperty(pair.key))
						throw new Error(`Property '${pair.key}' was encountered twice during serialization. Make sure injected properties do not collide with model properties.`);

					(result as any)[pair.key] = pair.value;
				}
			});
		return result;
	}

	deserialize(instance: Entity, data: any, property: Property, context: InitializationContext, constructEntity = true): any {
		// Apply custom converters before deserializing
		const converter = this._propertyConverters.find(c => c.shouldConvert(instance, property));
		if (converter)
			data = converter.deserialize(instance, data, property);

		if (data === IgnoreProperty)
			return;

		let value: any;

		const resolveEntity = (type: EntityConstructorForType<Entity>, state: any) => {
			let entity: Entity;
			let id: any = type.meta.identifier ? state[type.meta.identifier.name] : null;
			if (id)
				entity = type.meta.get(id);
			if (!entity)
				entity = new (type as any)(id, state, context);
			return entity;
		};

		// Entities
		if (isEntityType(property.propertyType)) {
			const ChildEntity = property.propertyType;

			if (!constructEntity)
				value = data;
			// Entity List
			else if (property.isList && Array.isArray(data))
				value = data.map(s => s instanceof ChildEntity ? s : resolveEntity(ChildEntity, s));
			// Entity
			else if (data instanceof ChildEntity)
				value = data;
			else if (data instanceof Object)
				value = resolveEntity(ChildEntity, data);
		}

		// Value List
		else if (property.isList && Array.isArray(data))
			value = data.map(i => this.deserialize(instance, i, property, context));

		// Value
		else if (property.format && data && typeof (data) === "string" && data.constructor !== property.propertyType)
			value = property.format.convertFromString(data);
		else
			value = data;

		return value;
	}

	getPropertyAliases(type: Type) {
		return Object.assign({}, this._propertyAliases.get(type), this._propertyAliases.get(type.fullName));
	}

	resolveProperty(context: Entity, propName: string) {
		let prop = context.meta.type.getProperty(propName);
		if (prop)
			return prop;

		propName = this.getPropertyAliases(context.meta.type)[propName];
		return context.meta.type.getProperty(propName);
	}

	resolveValue(context: Entity, property: Property, value: any): Promise<any> | void {
		for (const resolve of this._valueResolvers) {
			const result = resolve(context, property, value);
			if (result)
				return result;
		}
	}
}