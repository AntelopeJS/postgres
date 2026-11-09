import type { Journey } from "@antelopejs/tooling-configs/verify";

import { pick } from "./json.ts";
import { answered, close, open, ownedConfig, part, same, sees, server, sql } from "./session.ts";

const CATALOG = `{ products: { fields: { name: "string", price: "number", category: "string", tags: "string[]" }, indexes: { price: {}, category: {} } }, categories: { fields: { label: "string" }, indexes: {} } }`;

const COMPARED = ["cheap", "byPriceDesc", "between", "getAll", "count", "groups", "streamed"];

export const readQueries: Journey = {
  title: "filter, orderBy, between, getAll, pluck, count, group and a lookup answer what the same SQL answers, and a cursor reads past its batch size",
  entryPoint: "`table.filter/orderBy/between/getAll/pluck/count/group/lookup` and `for await` over a stream from a consumer module, with `cursorBatchSize: 2`",
  async run(context) {
    const session = await open(context, { ...ownedConfig(server(context)), cursorBatchSize: 2 });
    const result = await session.run(
      "query the products",
      `const schema = new Schema("verify-reads", ${CATALOG});
const products = schema.instance().table("products");
await schema.instance().table("categories").insert([{ _id: "c1", label: "Lighting" }, { _id: "c2", label: "Furniture" }]).run();
await products.insert([
  { _id: "p1", name: "lamp", price: 10, category: "c1", tags: ["home"] },
  { _id: "p2", name: "desk", price: 90, category: "c2", tags: ["office"] },
  { _id: "p3", name: "chair", price: 45, category: "c2", tags: ["office", "home"] },
  { _id: "p4", name: "bulb", price: 2, category: "c1", tags: [] },
  { _id: "p5", name: "shelf", price: 60, category: "c2", tags: ["home"] },
]).run();
const out = {};
out.cheap = (await products.filter((p) => p.key("price").lt(50)).orderBy("price").run()).map((p) => p._id);
out.byPriceDesc = (await products.orderBy("price", "desc").pluck("name").run()).map((p) => p.name);
out.between = (await products.between("price", 10, 60).orderBy("price").run()).map((p) => p._id);
out.getAll = (await products.getAll("c1", "category").orderBy("price").run()).map((p) => p._id);
out.count = await products.filter((p) => p.key("tags").includes("home")).count().run();
out.groups = (await products.group("category", (rows, category) => ({ category, n: rows.count() })).run()).map((g) => [g.category, g.n]).sort();
out.joined = (await products.get("p2").lookup(schema.instance().table("categories"), "category", "_id").run());
const streamed = [];
for await (const p of products.orderBy("_id")) streamed.push(p._id);
out.streamed = streamed;
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const expected = await sql(
      context,
      "the same reads in SQL",
      `SELECT json_build_object(
  'cheap', (SELECT json_agg(_id ORDER BY price) FROM "verify-reads".products WHERE price < 50),
  'byPriceDesc', (SELECT json_agg(name ORDER BY price DESC) FROM "verify-reads".products),
  'between', (SELECT json_agg(_id ORDER BY price) FROM "verify-reads".products WHERE price >= 10 AND price < 60),
  'getAll', (SELECT json_agg(_id ORDER BY price) FROM "verify-reads".products WHERE category = 'c1'),
  'count', (SELECT count(*) FROM "verify-reads".products WHERE tags @> '["home"]'),
  'groups', (SELECT json_agg(json_build_array(category, n) ORDER BY category) FROM (SELECT category, count(*) AS n FROM "verify-reads".products GROUP BY category) g),
  'streamed', (SELECT json_agg(_id ORDER BY _id) FROM "verify-reads".products))`,
    );
    context.expect(result.folder, [
      ...COMPARED.map((key) => same(`${key} answers what the same SQL answers`, pick(result.value, key), pick(expected.value, key))),
      sees("lookup joins the matching row under the local key", part(result, "joined"), {
        _id: "p2",
        category: { _id: "c2", label: "Furniture" },
        name: "desk",
        price: 90,
        tags: ["office"],
      }),
    ]);
    await close(session);
  },
};
