import { BetterAuthError } from "../../error";
import type { Adapter, BetterAuthOptions, Where } from "../../types";
import {
	createAdapterFactory,
	type AdapterDebugLogs,
	type AdapterFactoryOptions,
	type AdapterFactoryCustomizeAdapterCreator,
} from "../adapter-factory";

export interface PrismaConfig {
	/**
	 * Database provider.
	 */
	provider:
		| "sqlite"
		| "cockroachdb"
		| "mysql"
		| "postgresql"
		| "sqlserver"
		| "mongodb";

	/**
	 * Enable debug logs for the adapter
	 *
	 * @default false
	 */
	debugLogs?: AdapterDebugLogs;

	/**
	 * Use plural table names
	 *
	 * @default false
	 */
	usePlural?: boolean;

	/**
	 * Whether to execute multiple operations in a transaction.
	 *
	 * If the database doesn't support transactions,
	 * set this to `false` and operations will be executed sequentially.
	 * @default true
	 */
	transaction?: boolean;
}

interface PrismaClient {}

type PrismaClientInternal = {
	$transaction: (
		callback: (db: PrismaClient) => Promise<any> | any,
	) => Promise<any>;
} & {
	[model: string]: {
		create: (data: any) => Promise<any>;
		findFirst: (data: any) => Promise<any>;
		findMany: (data: any) => Promise<any>;
		update: (data: any) => Promise<any>;
		delete: (data: any) => Promise<any>;
		[key: string]: any;
	};
};
export const prismaAdapter = (prisma: PrismaClient, config: PrismaConfig) => {
	let lazyOptions: BetterAuthOptions | null = null;
	const createCustomAdapter =
		(prisma: PrismaClient): AdapterFactoryCustomizeAdapterCreator =>
		({ getFieldName }) => {
			const db = prisma as PrismaClientInternal;

			const convertSelect = (select?: string[], model?: string) => {
				if (!select || !model) return undefined;
				return select.reduce((prev, cur) => {
					return { ...prev, [getFieldName({ model, field: cur })]: true };
				}, {});
			};

			function operatorToPrismaOperator(operator: string) {
				switch (operator) {
					case "starts_with":
						return "startsWith";
					case "ends_with":
						return "endsWith";
					case "ne":
						return "not";
					case "not_in":
						return "notIn";
					default:
						return operator;
				}
			}

			const convertWhereClause = (model: string, where?: Where[]) => {
				if (!where) return {};
				if (where.length === 1) {
					const w = where[0]!;
					return {
						[getFieldName({ model, field: w.field })]:
							w.operator === "eq" || !w.operator
								? w.value
								: { [operatorToPrismaOperator(w.operator)]: w.value },
					};
				}
				const and = where.filter((w) => w.connector === "AND" || !w.connector);
				const or = where.filter((w) => w.connector === "OR");
				const andClause = and.map((w) => ({
					[getFieldName({ model, field: w.field })]:
						w.operator === "eq" || !w.operator
							? w.value
							: { [operatorToPrismaOperator(w.operator)]: w.value },
				}));
				const orClause = or.map((w) => ({
					[getFieldName({ model, field: w.field })]:
						w.operator === "eq" || !w.operator
							? w.value
							: { [operatorToPrismaOperator(w.operator)]: w.value },
				}));
				return { ...(andClause.length ? { AND: andClause } : {}), ...(orClause.length ? { OR: orClause } : {}) };
			};

			return {
				async create({ model, data: values, select }) {
					if (!db[model]) throw new BetterAuthError(`Model ${model} does not exist.`);
					return await db[model]!.create({ data: values, select: convertSelect(select, model) });
				},

				async findOne({ model, where, select }) {
					const whereClause = convertWhereClause(model, where);
					if (!db[model]) throw new BetterAuthError(`Model ${model} does not exist.`);

					if (model === "Authors") {
						// exclude soft-deleted users
						return await db[model]!.findFirst({
							where: { ...whereClause, deletedAt: null },
							select: convertSelect(select, model),
						});
					}

					if (model === "Sessions") {
						// check if linked author is deleted
						const session = await db[model]!.findFirst({
							where: whereClause,
							select: { ...convertSelect(select, model), author: { select: { deletedAt: true } } },
						});
						if (!session || session.author?.deletedAt) return null;
						const { author, ...rest } = session;
						return rest;
					}

					return await db[model]!.findFirst({ where: whereClause, select: convertSelect(select, model) });
				},

				async findMany({ model, where, limit, offset, sortBy }) {
					const whereClause = convertWhereClause(model, where);
					if (!db[model]) throw new BetterAuthError(`Model ${model} does not exist.`);

					if (model === "Authors") {
						return await db[model]!.findMany({
							where: { ...whereClause, deletedAt: null },
							take: limit || 100,
							skip: offset || 0,
							...(sortBy?.field
								? { orderBy: { [getFieldName({ model, field: sortBy.field })]: sortBy.direction === "desc" ? "desc" : "asc" } }
								: {}),
						});
					}

					if (model === "Sessions") {
						const sessions = await db[model]!.findMany({
							where: whereClause,
							include: { author: { select: { deletedAt: true } } },
							take: limit || 100,
							skip: offset || 0,
							...(sortBy?.field
								? { orderBy: { [getFieldName({ model, field: sortBy.field })]: sortBy.direction === "desc" ? "desc" : "asc" } }
								: {}),
						});
						return sessions.filter((s) => !s.author?.deletedAt).map(({ author, ...rest }) => rest);
					}

					return await db[model]!.findMany({
						where: whereClause,
						take: limit || 100,
						skip: offset || 0,
						...(sortBy?.field
							? { orderBy: { [getFieldName({ model, field: sortBy.field })]: sortBy.direction === "desc" ? "desc" : "asc" } }
							: {}),
					});
				},

				async count({ model, where }) {
					const whereClause = convertWhereClause(model, where);
					if (!db[model]) throw new BetterAuthError(`Model ${model} does not exist.`);

					if (model === "Authors") {
						return await db[model]!.count({ where: { ...whereClause, deletedAt: null } });
					}

					if (model === "Sessions") {
						const sessions = await db[model]!.findMany({ where: whereClause, include: { author: { select: { deletedAt: true } } } });
						return sessions.filter((s) => !s.author?.deletedAt).length;
					}

					return await db[model]!.count({ where: whereClause });
				},

				async update({ model, where, update }) {
					const whereClause = convertWhereClause(model, where);
					if (!db[model]) throw new BetterAuthError(`Model ${model} does not exist.`);
					return await db[model]!.update({ where: whereClause, data: update });
				},

				async updateMany({ model, where, update }) {
					const whereClause = convertWhereClause(model, where);
					const result = await db[model]!.updateMany({ where: whereClause, data: update });
					return result ? (result.count as number) : 0;
				},

				async delete({ model, where }) {
					const whereClause = convertWhereClause(model, where);
					if (model === "Authors") {
						await db[model]!.update({ where: whereClause, data: { deletedAt: new Date() } });
						return;
					}
					try {
						await db[model]!.delete({ where: whereClause });
					} catch {}
				},

				async deleteMany({ model, where }) {
					const whereClause = convertWhereClause(model, where);
					if (model === "Authors") {
						const result = await db[model]!.updateMany({ where: whereClause, data: { deletedAt: new Date() } });
						return result ? (result.count as number) : 0;
					}
					const result = await db[model]!.deleteMany({ where: whereClause });
					return result ? (result.count as number) : 0;
				},

				options: config,
			};
		};

	let adapterOptions: AdapterFactoryOptions | null = null;
	adapterOptions = {
		config: {
			adapterId: "prisma",
			adapterName: "Prisma Adapter",
			usePlural: config.usePlural ?? false,
			debugLogs: config.debugLogs ?? false,
			transaction:
				(config.transaction ?? false)
					? (cb) =>
							(prisma as PrismaClientInternal).$transaction((tx) => {
								const adapter = createAdapterFactory({ config: adapterOptions!.config, adapter: createCustomAdapter(tx) })(lazyOptions!);
								return cb(adapter);
							})
					: false,
		},
		adapter: createCustomAdapter(prisma),
	};

	const adapter = createAdapterFactory(adapterOptions);
	return (options: BetterAuthOptions): Adapter => {
		lazyOptions = options;
		return adapter(options);
	};
};
