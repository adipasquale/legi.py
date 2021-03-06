const makeArticle = require("./makeArticle");
const makeSection = require("./makeSection");
const makeTetier = require("./makeTetier");
const makeTexte = require("./makeTexte");
const { getItemType } = require("./utils");

const makeItem = itemType => {
  return {
    article: makeArticle,
    section: makeSection,
    tetier: makeTetier,
    texte: makeTexte
  }[itemType];
};

// postgreSQL queries to get the full structure in a single-query

// basic SQL date/vigueur filters
const getSommaireFilters = date => `
  (
    sommaires.debut <= '${date}'
    OR sommaires.debut IS NULL  /* those from conteneurs */
  ) AND (
    sommaires.fin > '${date}'
    OR sommaires.fin = '${date}'
    OR sommaires.fin IS NULL  /* those from conteneurs */
    OR LEFT(sommaires.etat, 7) = 'VIGUEUR'
  )
`;

// add sections + articles basic data from the sommaires results
const getStructureSQL = ({
  date,
  initialCondition = "sommaires.parent is null",
  maxDepth = 1,
  includeCalipsos = false
}) => `

${/* DECLARE RECURSIVE FUNCTION */ ""}
${/* get full structure in a one-shot flat array */ ""}

 WITH RECURSIVE hierarchie(element, depth) AS (
  SELECT sommaires.element, 0 as depth, sommaires.position, sommaires.etat, sommaires.num, sommaires.parent, sommaires.debut, sommaires.fin
    FROM sommaires
    WHERE ${getSommaireFilters(date)}
    and ${initialCondition}
  UNION ALL
  SELECT DISTINCT sommaires.element, depth + 1 as depth, sommaires.position, sommaires.etat, sommaires.num, sommaires.parent, sommaires.debut, sommaires.fin
    FROM sommaires, hierarchie
    WHERE ${getSommaireFilters(date)}
    and sommaires.parent = hierarchie.element
    ${maxDepth > 0 ? `and depth <= ${Math.max(0, maxDepth - 1)}` : ``}
 )

${/* map some data from previous recursive call */ ""}

SELECT
  hierarchie.element as id,
  hierarchie.parent,
  tetiers.titre_tm as titre,
  hierarchie.position,
  hierarchie.etat,
  hierarchie.num,
  NULL AS nature,
  NULL AS date_texte,
  NULL AS origine_publi
  ${includeCalipsos ? ", NULL AS calipsos" : ""}
FROM hierarchie
LEFT JOIN tetiers ON tetiers.id = hierarchie.element
WHERE SUBSTR(hierarchie.element, 5, 2) = 'TM'
UNION ALL(
  SELECT
    hierarchie.element AS id,
    hierarchie.parent,
    textes_versions.titre AS titre,
    hierarchie.position,
    hierarchie.etat,
    NULL AS num,
    textes_versions.nature AS nature,
    textes_versions.date_texte AS date_texte,
    textes_versions.origine_publi AS origine_publi
    ${includeCalipsos ? ", NULL AS calipsos" : ""}
  FROM hierarchie
  LEFT JOIN textes_versions ON textes_versions.id = hierarchie.element
  WHERE SUBSTR(hierarchie.element, 5, 4) = 'TEXT'
)
UNION ALL(
  SELECT
    hierarchie.element AS id,
    hierarchie.parent,
    sections.titre_ta AS titre,
    hierarchie.position,
    hierarchie.etat,
    NULL AS num,
    NULL AS nature,
    NULL AS date_texte,
    NULL AS origine_publi
    ${includeCalipsos ? ", NULL AS calipsos" : ""}
  FROM hierarchie
  LEFT JOIN sections ON sections.id = hierarchie.element
  WHERE SUBSTR(hierarchie.element, 5, 4) = 'SCTA'
)
UNION ALL(
  SELECT
    hierarchie.element as id,
    hierarchie.parent,
    CONCAT('Article ', COALESCE(hierarchie.num, articles.num), ' ', articles.titre) AS titre,
    hierarchie.position,
    hierarchie.etat,
    COALESCE(hierarchie.num, articles.num, 'inconnu'),
    NULL AS nature,
    NULL AS date_texte,
    NULL AS origine_publi
    ${includeCalipsos ? ", string_agg(articles_calipsos.calipso_id, ',') AS calipsos" : ""}
  FROM hierarchie
  LEFT JOIN articles ON articles.id = hierarchie.element
  ${
    includeCalipsos
      ? "LEFT JOIN articles_calipsos ON articles_calipsos.article_id = articles.id"
      : ""
  }
  WHERE SUBSTR(hierarchie.element, 5, 4) = 'ARTI'
  ${
    includeCalipsos
      ? `GROUP BY articles.id, hierarchie.element, hierarchie.parent,
        hierarchie.num, articles.num, articles.titre,
        hierarchie.position, hierarchie.etat`
      : ""
  }
  ORDER BY articles.id
  )
`;

// SQL where id IN (x, y, z) query
const getRowsIn = (knex, table, ids, key = "id") => knex.from(table).whereIn(key, ids);
const reformatRows = row => ({ ...row, titre: row.titre_ta || row.titre_tm || row.titre });

const itemTypeToTable = itemType => (itemType == "texte" ? "textes_versions" : `${itemType}s`);

// get flat rows with the articles/sections for given section/date
const getRawStructure = async ({ knex, parentId, section, date, maxDepth = 0, ...extraParams }) =>
  knex.raw(
    getStructureSQL({
      date,
      parentId,
      maxDepth,
      initialCondition: `sommaires.parent='${parentId}'`,
      ...extraParams
    })
  );

// build AST-like deep structure for a given node
// useful for full data dumps
const getStructure = async ({
  knex,
  parentId = undefined,
  section = undefined,
  date,
  maxDepth = 0
}) =>
  getRawStructure({ knex, section, parentId, date, maxDepth }).then(async result => {
    // cache related data
    const cache = {};
    for (const itemType of ["article", "texte", "section", "tetier"]) {
      cache[itemTypeToTable(itemType)] = await getRowsIn(
        knex,
        itemTypeToTable(itemType),
        result.rows.filter(row => getItemType(row) === itemType).map(row => row.id)
      ).map(reformatRows);
    }

    // enrich sommaire rows with related data (sections, articles)
    // add hierarchical data so we can build an AST later on
    const getRow = row => {
      const itemType = getItemType(row);
      const item = cache[itemTypeToTable(itemType)].find(item => item.id === row.id);
      if (!item) return null;
      // this should not happen. I'd like to warn here (not raise),
      // but I don't know how to do it in node, I don't have access to Sentry here
      return makeItem(itemType)({
        ...item,
        position: row.position,
        parent: row.parent
      });
    };
    return result.rows.map(getRow).filter(x => x !== null);
  });

module.exports = { getStructure, getRawStructure, getSommaireFilters };
