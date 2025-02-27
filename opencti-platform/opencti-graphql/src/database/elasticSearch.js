/* eslint-disable no-underscore-dangle */
import { Client } from '@elastic/elasticsearch';
import { Promise } from 'bluebird';
import * as R from 'ramda';
import {
  buildPagination,
  cursorToOffset,
  isEmptyField,
  isNotEmptyField,
  offsetToCursor,
  pascalize,
  READ_DATA_INDICES,
  READ_INDEX_STIX_CYBER_OBSERVABLE_RELATIONSHIPS,
  READ_INDEX_STIX_DOMAIN_OBJECTS,
  READ_PLATFORM_INDICES,
  READ_RELATIONSHIPS_INDICES,
  WRITE_PLATFORM_INDICES,
} from './utils';
import conf, { booleanConf, logApp } from '../config/conf';
import { ConfigurationError, DatabaseError, FunctionalError } from '../config/errors';
import {
  EXTERNAL_META_TO_STIX_ATTRIBUTE,
  RELATION_CREATED_BY,
  RELATION_KILL_CHAIN_PHASE,
  RELATION_OBJECT,
  RELATION_OBJECT_LABEL,
  RELATION_OBJECT_MARKING,
} from '../schema/stixMetaRelationship';
import {
  ABSTRACT_BASIC_RELATIONSHIP,
  BASE_TYPE_RELATION,
  buildRefRelationKey,
  buildRefRelationSearchKey,
  ID_INTERNAL,
  ID_STANDARD,
  IDS_STIX,
  INTERNAL_IDS_ALIASES,
  isAbstract,
  REL_INDEX_PREFIX,
  RULE_PREFIX,
} from '../schema/general';
import {
  dateAttributes,
  isBooleanAttribute,
  isMultipleAttribute,
  numericOrBooleanAttributes,
} from '../schema/fieldDataAdapter';
import { convertEntityTypeToStixType, getParentTypes } from '../schema/schemaUtils';
import { isStixObjectAliased } from '../schema/stixDomainObject';
import { isStixObject } from '../schema/stixCoreObject';
import { isBasicRelationship, isStixRelationShipExceptMeta } from '../schema/stixRelationship';
import { RELATION_INDICATES } from '../schema/stixCoreRelationship';
import { getInstanceIds, INTERNAL_FROM_FIELD, INTERNAL_TO_FIELD } from '../schema/identifier';
import { BYPASS } from '../utils/access';
import { cacheDel, cacheGet, cachePurge, cacheSet } from './redis';

export const ES_MAX_CONCURRENCY = conf.get('elasticsearch:max_concurrency');
export const ES_IGNORE_THROTTLED = conf.get('elasticsearch:search_ignore_throttled');
export const ES_MAX_PAGINATION = conf.get('elasticsearch:max_pagination_result');
const ES_RETRY_ON_CONFLICT = 5;
export const MAX_SPLIT = 250; // Max number of terms resolutions (ES limitation)
export const BULK_TIMEOUT = '5m';
const MAX_AGGREGATION_SIZE = 100;
const MAX_JS_PARAMS = 65536; // Too prevent Maximum call stack size exceeded
const MAX_SEARCH_AGGREGATION_SIZE = 10000;
const MAX_SEARCH_SIZE = 5000;
export const ROLE_FROM = 'from';
export const ROLE_TO = 'to';
const UNIMPACTED_ENTITIES_ROLE = [
  `${RELATION_CREATED_BY}_${ROLE_TO}`,
  `${RELATION_OBJECT_MARKING}_${ROLE_TO}`,
  `${RELATION_OBJECT_LABEL}_${ROLE_TO}`,
  `${RELATION_KILL_CHAIN_PHASE}_${ROLE_TO}`,
  `${RELATION_INDICATES}_${ROLE_TO}`,
];
const SOURCE_EXCLUDED_FIELDS = [`${REL_INDEX_PREFIX}${RELATION_OBJECT}`];
export const isImpactedTypeAndSide = (type, side) => {
  return !UNIMPACTED_ENTITIES_ROLE.includes(`${type}_${side}`);
};
export const isImpactedRole = (role) => !UNIMPACTED_ENTITIES_ROLE.includes(role);

export const el = new Client({
  node: conf.get('elasticsearch:url'),
  proxy: conf.get('elasticsearch:proxy') || null,
  auth: {
    username: conf.get('elasticsearch:username') || null,
    password: conf.get('elasticsearch:password') || null,
    apiKey: conf.get('elasticsearch:api_key') || null,
  },
  maxRetries: conf.get('elasticsearch:max_retries') || 3,
  requestTimeout: conf.get('elasticsearch:request_timeout') || 30000,
  sniffOnStart: booleanConf('elasticsearch:sniff_on_start', false),
  ssl: {
    ca: conf.get('elasticsearch:ssl:ca') || null,
    rejectUnauthorized: booleanConf('elasticsearch:ssl:reject_unauthorized', true),
  },
});

const buildMarkingRestriction = (user) => {
  const must = [];
  // eslint-disable-next-line camelcase
  const must_not = [];
  // Check user rights
  const isBypass = R.find((s) => s.name === BYPASS, user.capabilities || []) !== undefined;
  if (!isBypass) {
    if (user.allowed_marking.length === 0) {
      // If user have no marking, he can only access to data with no markings.
      must_not.push({ exists: { field: buildRefRelationKey(RELATION_OBJECT_MARKING) } });
    } else {
      // Markings should be group by types for restriction
      const userGroupedMarkings = R.groupBy((m) => m.definition_type, user.allowed_marking);
      const allGroupedMarkings = R.groupBy((m) => m.definition_type, user.all_marking);
      const markingGroups = Object.keys(allGroupedMarkings);
      const mustNotHaveOneOf = [];
      for (let index = 0; index < markingGroups.length; index += 1) {
        const markingGroup = markingGroups[index];
        const markingsForGroup = allGroupedMarkings[markingGroup].map((i) => i.internal_id);
        const userMarkingsForGroup = (userGroupedMarkings[markingGroup] || []).map((i) => i.internal_id);
        // Get all markings the user has no access for this group
        const res = markingsForGroup.filter((m) => !userMarkingsForGroup.includes(m));
        if (res.length > 0) {
          mustNotHaveOneOf.push(res);
        }
      }
      // If use have marking, he can access to data with no marking && data with according marking
      const mustNotMarkingTerms = [];
      for (let i = 0; i < mustNotHaveOneOf.length; i += 1) {
        const markings = mustNotHaveOneOf[i];
        const should = markings.map((m) => ({ match: { [buildRefRelationSearchKey(RELATION_OBJECT_MARKING)]: m } }));
        mustNotMarkingTerms.push({
          bool: {
            should,
            minimum_should_match: 1,
          },
        });
      }
      const markingBool = {
        bool: {
          should: [
            {
              bool: {
                must_not: [{ exists: { field: buildRefRelationSearchKey(RELATION_OBJECT_MARKING) } }],
              },
            },
            {
              bool: {
                must_not: mustNotMarkingTerms,
              },
            },
          ],
          minimum_should_match: 1,
        },
      };
      must.push(markingBool);
    }
  }
  return { must, must_not };
};

export const elIsAlive = async () => {
  return el
    .info()
    .then((info) => {
      /* istanbul ignore if */
      if (info.meta.connection.status !== 'alive') {
        throw ConfigurationError('ElasticSearch seems down (status not alive)');
      }
      return true;
    })
    .catch(
      /* istanbul ignore next */ (e) => {
        throw ConfigurationError('ElasticSearch seems down', { error: e.message });
      }
    );
};
export const elVersion = () => {
  return el
    .info()
    .then((info) => info.body.version.number)
    .catch(
      /* istanbul ignore next */ () => {
        return 'Disconnected';
      }
    );
};
export const elIndexExists = async (indexName) => {
  const existIndex = await el.indices.exists({ index: indexName });
  return existIndex.body === true;
};
export const elCreateIndexes = async (indexesToCreate = WRITE_PLATFORM_INDICES) => {
  const defaultIndexPattern = conf.get('elasticsearch:index_creation_pattern');
  return Promise.all(
    indexesToCreate.map((index) => {
      return el.indices.exists({ index }).then((result) => {
        if (result.body === false) {
          return el.indices
            .create({
              index: `${index}${defaultIndexPattern}`,
              body: {
                aliases: { [index]: {} },
                settings: {
                  index: {
                    max_result_window: 100000,
                  },
                  analysis: {
                    normalizer: {
                      string_normalizer: {
                        type: 'custom',
                        filter: ['lowercase', 'asciifolding'],
                      },
                    },
                  },
                },
                mappings: {
                  dynamic_templates: [
                    {
                      integers: {
                        match_mapping_type: 'long',
                        mapping: {
                          type: 'integer',
                        },
                      },
                    },
                    {
                      strings: {
                        match_mapping_type: 'string',
                        mapping: {
                          type: 'text',
                          fields: {
                            keyword: {
                              type: 'keyword',
                              normalizer: 'string_normalizer',
                              ignore_above: 512,
                            },
                          },
                        },
                      },
                    },
                  ],
                  properties: {
                    standard_id: {
                      type: 'text',
                      fields: {
                        keyword: {
                          type: 'keyword',
                          normalizer: 'string_normalizer',
                          ignore_above: 512,
                        },
                      },
                    },
                    timestamp: {
                      type: 'date',
                    },
                    created: {
                      type: 'date',
                    },
                    modified: {
                      type: 'date',
                    },
                    first_seen: {
                      type: 'date',
                    },
                    last_seen: {
                      type: 'date',
                    },
                    start_time: {
                      type: 'date',
                    },
                    stop_time: {
                      type: 'date',
                    },
                    published: {
                      type: 'date',
                    },
                    valid_from: {
                      type: 'date',
                    },
                    valid_until: {
                      type: 'date',
                    },
                    observable_date: {
                      type: 'date',
                    },
                    event_date: {
                      type: 'date',
                    },
                    received_time: {
                      type: 'date',
                    },
                    processed_time: {
                      type: 'date',
                    },
                    completed_time: {
                      type: 'date',
                    },
                    ctime: {
                      type: 'date',
                    },
                    mtime: {
                      type: 'date',
                    },
                    atime: {
                      type: 'date',
                    },
                    confidence: {
                      type: 'integer',
                    },
                    x_opencti_report_status: {
                      type: 'integer',
                    },
                    attribute_order: {
                      type: 'integer',
                    },
                    base_score: {
                      type: 'integer',
                    },
                    is_family: {
                      type: 'boolean',
                    },
                    number_observed: {
                      type: 'integer',
                    },
                    x_opencti_negative: {
                      type: 'boolean',
                    },
                    default_assignation: {
                      type: 'boolean',
                    },
                    x_opencti_detection: {
                      type: 'boolean',
                    },
                    x_opencti_order: {
                      type: 'integer',
                    },
                    import_expected_number: {
                      type: 'integer',
                    },
                    import_processed_number: {
                      type: 'integer',
                    },
                    x_opencti_score: {
                      type: 'integer',
                    },
                    connections: {
                      type: 'nested',
                    },
                  },
                },
              },
            })
            .catch((e) => {
              throw DatabaseError('Error creating index', { error: e });
            });
        }
        /* istanbul ignore next */
        return result;
      });
    })
  );
};
export const elDeleteIndexes = async (indexesToDelete) => {
  return Promise.all(
    indexesToDelete.map((index) => {
      return el.indices.delete({ index }).catch((err) => {
        /* istanbul ignore next */
        if (err.meta.body && err.meta.body.error.type !== 'index_not_found_exception') {
          logApp.error(`[ELASTICSEARCH] Delete indices fail`, { error: err });
        }
      });
    })
  );
};

export const elCount = (user, indexName, options = {}) => {
  const {
    endDate = null,
    types = null,
    relationshipType = null,
    authorId = null,
    fromId = null,
    toTypes = null,
    isMetaRelationship = false,
  } = options;
  let must = [];
  const markingRestrictions = buildMarkingRestriction(user);
  must.push(...markingRestrictions.must);
  if (endDate !== null) {
    must = R.append(
      {
        range: {
          created_at: {
            format: 'strict_date_optional_time',
            lt: endDate,
          },
        },
      },
      must
    );
  }
  if (types !== null && types.length > 0) {
    const should = types.map((typeValue) => {
      return {
        bool: {
          should: [
            { match_phrase: { 'entity_type.keyword': typeValue } },
            { match_phrase: { 'parent_types.keyword': typeValue } },
          ],
          minimum_should_match: 1,
        },
      };
    });
    must = R.append(
      {
        bool: {
          should,
          minimum_should_match: 1,
        },
      },
      must
    );
  }
  if (relationshipType !== null && !isMetaRelationship) {
    must = R.append(
      {
        bool: {
          should: {
            match_phrase: { 'relationship_type.keyword': relationshipType },
          },
        },
      },
      must
    );
  }
  if (authorId !== null && !isMetaRelationship) {
    must = R.append(
      {
        bool: {
          should: {
            match_phrase: { [buildRefRelationSearchKey(RELATION_CREATED_BY)]: authorId },
          },
        },
      },
      must
    );
  }
  if (fromId !== null) {
    if (isMetaRelationship) {
      must = R.append(
        {
          bool: {
            should: {
              match_phrase: { [buildRefRelationSearchKey(relationshipType)]: fromId },
            },
          },
        },
        must
      );
    } else {
      must = R.append(
        {
          nested: {
            path: 'connections',
            query: {
              bool: {
                must: [{ match_phrase: { [`connections.internal_id.keyword`]: fromId } }],
              },
            },
          },
        },
        must
      );
    }
  }
  if (toTypes !== null) {
    const filters = [];
    for (let index = 0; index < toTypes.length; index += 1) {
      filters.push({
        match_phrase: { 'connections.types.keyword': toTypes[index] },
      });
    }
    must = R.append(
      {
        nested: {
          path: 'connections',
          query: {
            bool: {
              should: filters,
              minimum_should_match: 1,
            },
          },
        },
      },
      must
    );
  }
  const query = {
    index: indexName,
    body: {
      query: {
        bool: {
          must,
          must_not: markingRestrictions.must_not,
        },
      },
    },
  };
  logApp.debug(`[ELASTICSEARCH] countEntities`, { query });
  return el
    .count(query)
    .then((data) => {
      return data.body.count;
    })
    .catch((err) => {
      throw DatabaseError('Count data fail', { error: err, query });
    });
};
export const elAggregationCount = (user, type, aggregationField, start, end, filters = []) => {
  const isIdFields = aggregationField.endsWith('internal_id');
  const haveRange = start && end;
  const dateFilter = [];
  if (haveRange) {
    dateFilter.push({
      range: {
        created_at: {
          gte: start,
          lte: end,
        },
      },
    });
  }
  const histoFilters = R.map((f) => {
    const key = f.isRelation ? buildRefRelationSearchKey(f.type || '*') : `${f.type}.keyword`;
    return {
      multi_match: {
        fields: [key],
        type: 'phrase',
        query: f.value,
      },
    };
  }, filters);
  const must = R.concat(dateFilter, histoFilters);
  const markingRestrictions = buildMarkingRestriction(user);
  must.push(...markingRestrictions.must);
  const query = {
    index: READ_PLATFORM_INDICES,
    body: {
      size: MAX_SEARCH_AGGREGATION_SIZE,
      query: {
        bool: {
          must,
          must_not: markingRestrictions.must_not,
          should: [
            { match_phrase: { 'entity_type.keyword': type } },
            { match_phrase: { 'parent_types.keyword': type } },
          ],
          minimum_should_match: 1,
        },
      },
      aggs: {
        genres: {
          terms: {
            field: `${aggregationField}.keyword`,
            size: MAX_AGGREGATION_SIZE,
          },
        },
      },
    },
  };
  logApp.debug(`[ELASTICSEARCH] aggregationCount`, { query });
  return el
    .search(query)
    .then((data) => {
      const { buckets } = data.body.aggregations.genres;
      return R.map((b) => ({ label: isIdFields ? b.key : pascalize(b.key), value: b.doc_count }), buckets);
    })
    .catch((err) => {
      throw DatabaseError('Aggregation fail', { error: err, query });
    });
};
// region relation reconstruction
const elBuildRelation = (type, connection) => {
  return {
    [type]: null,
    [`${type}Id`]: connection.internal_id,
    [`${type}Role`]: connection.role,
    [`${type}Type`]: R.head(connection.types),
  };
};
const elMergeRelation = (concept, fromConnection, toConnection) => {
  if (!fromConnection || !toConnection) {
    throw DatabaseError(`[ELASTIC] Something fail in reconstruction of the relation`, concept.internal_id);
  }
  const from = elBuildRelation('from', fromConnection);
  from.source_ref = `${convertEntityTypeToStixType(from.fromType)}--temporary`;
  const to = elBuildRelation('to', toConnection);
  to.target_ref = `${convertEntityTypeToStixType(to.toType)}--temporary`;
  return R.mergeAll([concept, from, to]);
};
export const elRebuildRelation = (concept) => {
  if (concept.base_type === BASE_TYPE_RELATION) {
    const { connections } = concept;
    const entityType = concept.entity_type;
    const fromConnection = R.find((connection) => connection.role === `${entityType}_from`, connections);
    const toConnection = R.find((connection) => connection.role === `${entityType}_to`, connections);
    const relation = elMergeRelation(concept, fromConnection, toConnection);
    relation.relationship_type = relation.entity_type;
    return R.dissoc('connections', relation);
  }
  return concept;
};
const elDataConverter = (esHit) => {
  const elementData = esHit._source;
  const data = {
    _index: esHit._index,
    id: elementData.internal_id,
    sort: esHit.sort,
    ...elRebuildRelation(elementData),
  };
  const entries = Object.entries(data);
  const ruleInferences = [];
  for (let index = 0; index < entries.length; index += 1) {
    const [key, val] = entries[index];
    if (key.startsWith(RULE_PREFIX)) {
      const rule = key.substr(RULE_PREFIX.length);
      const ruleDefinitions = Object.values(val);
      for (let rIndex = 0; rIndex < ruleDefinitions.length; rIndex += 1) {
        const { inferred, explanation } = ruleDefinitions[rIndex];
        const attributes = R.toPairs(inferred).map((s) => ({ field: R.head(s), value: String(R.last(s)) }));
        ruleInferences.push({ rule, explanation, attributes });
      }
      data[key] = val;
    } else if (key.startsWith(REL_INDEX_PREFIX)) {
      const rel = key.substr(REL_INDEX_PREFIX.length);
      const [relType] = rel.split('.');
      const stixType = EXTERNAL_META_TO_STIX_ATTRIBUTE[relType];
      if (stixType) {
        data[stixType] = stixType.endsWith('_refs') ? val : R.head(val);
      }
    } else {
      data[key] = val;
    }
  }
  if (ruleInferences.length > 0) {
    data.x_opencti_inferences = ruleInferences;
  }
  if (data.event_data) {
    data.event_data = JSON.stringify(data.event_data);
  }
  return data;
};

// endregion
export const elFindByFromAndTo = async (user, fromId, toId, relationshipType) => {
  const mustTerms = [];
  const markingRestrictions = buildMarkingRestriction(user);
  mustTerms.push(...markingRestrictions.must);
  mustTerms.push({
    nested: {
      path: 'connections',
      query: {
        bool: {
          must: [{ match_phrase: { 'connections.internal_id.keyword': fromId } }],
        },
      },
    },
  });
  mustTerms.push({
    nested: {
      path: 'connections',
      query: {
        bool: {
          must: [{ match_phrase: { 'connections.internal_id.keyword': toId } }],
        },
      },
    },
  });
  mustTerms.push({
    bool: {
      should: [
        { match_phrase: { 'entity_type.keyword': relationshipType } },
        { match_phrase: { 'parent_types.keyword': relationshipType } },
      ],
      minimum_should_match: 1,
    },
  });
  const query = {
    index: READ_RELATIONSHIPS_INDICES,
    size: MAX_SEARCH_SIZE,
    _source_excludes: SOURCE_EXCLUDED_FIELDS,
    ignore_throttled: ES_IGNORE_THROTTLED,
    body: {
      query: {
        bool: {
          must: mustTerms,
          must_not: markingRestrictions.must_not,
        },
      },
    },
  };
  const data = await el.search(query).catch((e) => {
    throw DatabaseError('Find by from and to fail', { error: e, query });
  });
  const hits = [];
  for (let index = 0; index < data.body.hits.hits.length; index += 1) {
    const hit = data.body.hits.hits[index];
    hits.push(elDataConverter(hit));
  }
  return hits;
};

const loadFromCache = async (user, id, type) => {
  const data = await cacheGet(id);
  const cachedValues = data ? Object.values(data).filter((e) => isNotEmptyField(e)) : [];
  const cached = R.flatten(cachedValues.map((v) => getInstanceIds(v)));
  const accessible = R.filter((instance) => {
    if (!instance) {
      return false;
    }
    const isBypass = R.find((s) => s.name === BYPASS, user.capabilities || []) !== undefined;
    if (!isBypass) {
      const dataMarkings = instance.object_marking_refs || [];
      const userMarkings = (user.allowed_marking || []).map((a) => a.internal_id);
      const isUserHaveAccess = dataMarkings.length === 0 || dataMarkings.every((m) => userMarkings.includes(m));
      if (!isUserHaveAccess) {
        return false;
      }
    }
    // Check type
    const dataTypes = [instance.entity_type, ...getParentTypes(instance.entity_type)];
    return !(type && !dataTypes.includes(type));
  }, data || {});
  const uniqByInternal = R.mergeAll(Object.entries(accessible).map(([, v]) => ({ [v.internal_id]: v })));
  return { cached, accessible: uniqByInternal };
};
export const elFindByIds = async (user, ids, opts = {}) => {
  const { indices = READ_DATA_INDICES, toMap = false, type = null } = opts;
  const idsArray = Array.isArray(ids) ? ids : [ids];
  const processIds = R.filter((id) => isNotEmptyField(id), idsArray);
  if (processIds.length === 0) {
    return toMap ? {} : [];
  }
  const { cached, accessible } = await loadFromCache(user, ids, type);
  const cacheHits = { ...accessible };
  const remainingIds = processIds.filter((id) => !cached.includes(id));
  const elasticHits = {};
  if (remainingIds.length > 0) {
    // const startTime = Date.now();
    const groupIds = R.splitEvery(MAX_SPLIT, remainingIds);
    for (let index = 0; index < groupIds.length; index += 1) {
      const mustTerms = [];
      const workingIds = groupIds[index];
      const idsTermsPerType = [];
      const elementTypes = [ID_INTERNAL, ID_STANDARD, IDS_STIX];
      if (isStixObjectAliased(type)) {
        elementTypes.push(INTERNAL_IDS_ALIASES);
      }
      for (let i = 0; i < workingIds.length; i += 1) {
        const id = workingIds[i];
        for (let indexType = 0; indexType < elementTypes.length; indexType += 1) {
          const elementType = elementTypes[indexType];
          const term = { [`${elementType}.keyword`]: id };
          idsTermsPerType.push({ term });
        }
      }
      const should = {
        bool: {
          should: idsTermsPerType,
          minimum_should_match: 1,
        },
      };
      mustTerms.push(should);
      if (type) {
        const shouldType = {
          bool: {
            should: [
              { match_phrase: { 'entity_type.keyword': type } },
              { match_phrase: { 'parent_types.keyword': type } },
            ],
            minimum_should_match: 1,
          },
        };
        mustTerms.push(shouldType);
      }
      const markingRestrictions = buildMarkingRestriction(user);
      mustTerms.push(...markingRestrictions.must);
      const query = {
        index: indices,
        size: MAX_SEARCH_SIZE,
        _source_excludes: SOURCE_EXCLUDED_FIELDS,
        ignore_throttled: ES_IGNORE_THROTTLED,
        body: {
          query: {
            bool: {
              must: mustTerms,
              must_not: markingRestrictions.must_not,
            },
          },
        },
      };
      logApp.debug(`[ELASTICSEARCH] elInternalLoadById`, { query });
      const data = await el.search(query).catch((err) => {
        throw DatabaseError('Error loading ids', { error: err, query });
      });
      for (let j = 0; j < data.body.hits.hits.length; j += 1) {
        const hit = data.body.hits.hits[j];
        const element = elDataConverter(hit);
        elasticHits[element.internal_id] = element;
      }
      await cacheSet(Object.values(elasticHits));
    }
  }
  const hits = { ...cacheHits, ...elasticHits };
  return toMap ? hits : Object.values(hits);
};

export const elLoadById = async (user, id, type = null, indices = READ_DATA_INDICES) => {
  const hits = await elFindByIds(user, id, { type, indices });
  /* istanbul ignore if */
  if (hits.length > 1) {
    const errorMeta = { id, type, hits: hits.length };
    throw DatabaseError('Expect only one response', errorMeta);
  }
  return R.head(hits);
};
export const elBatchIds = async (user, ids) => {
  const hits = await elFindByIds(user, ids);
  return ids.map((id) => R.find((h) => h.internal_id === id, hits));
};

// field can be "entity_type" or "internal_id"
export const elAggregationRelationsCount = async (user, type, opts) => {
  const { startDate: start, endDate: end, toTypes = [], dateAttribute = 'created_at' } = opts;
  const { fromId = null, field = null, isTo = false, noDirection = false } = opts;
  if (!R.includes(field, ['entity_type', 'internal_id', null])) {
    throw FunctionalError('Unsupported field', field);
  }
  const roleFilter = { query_string: { query: !isTo ? `*_to` : `*_from`, fields: [`connections.role`] } };
  const haveRange = start && end;
  const filters = [];
  if (haveRange) {
    filters.push({ range: { [dateAttribute]: { gte: start, lte: end } } });
  } else if (start) {
    filters.push({ range: { [dateAttribute]: { gte: start } } });
  } else if (end) {
    filters.push({ range: { [dateAttribute]: { lte: end } } });
  }
  if (fromId) {
    filters.push({
      nested: {
        path: 'connections',
        query: {
          bool: {
            must: [{ match_phrase: { [`connections.internal_id`]: fromId } }],
          },
        },
      },
    });
  }
  const typesFilters = [];
  for (let index = 0; index < toTypes.length; index += 1) {
    typesFilters.push({
      match_phrase: { 'connections.types': toTypes[index] },
    });
  }
  if (typesFilters.length > 0) {
    filters.push({
      nested: {
        path: 'connections',
        query: {
          bool: {
            should: typesFilters,
            minimum_should_match: 1,
          },
        },
      },
    });
  }
  const must = R.concat(
    [
      {
        bool: {
          should: [
            { match_phrase: { 'entity_type.keyword': type } },
            { match_phrase: { 'parent_types.keyword': type } },
          ],
          minimum_should_match: 1,
        },
      },
    ],
    filters
  );
  const markingRestrictions = buildMarkingRestriction(user);
  must.push(...markingRestrictions.must);
  const query = {
    index: READ_RELATIONSHIPS_INDICES,
    ignore_throttled: ES_IGNORE_THROTTLED,
    body: {
      size: MAX_SEARCH_AGGREGATION_SIZE,
      query: {
        bool: {
          must,
          must_not: markingRestrictions.must_not,
        },
      },
      aggs: {
        connections: {
          nested: {
            path: 'connections',
          },
          aggs: {
            filtered: {
              filter: {
                bool: {
                  must: typesFilters.length > 0 && !noDirection ? roleFilter : [],
                },
              },
              aggs: {
                genres: {
                  terms: {
                    size: MAX_AGGREGATION_SIZE,
                    field: field === 'internal_id' ? `connections.internal_id.keyword` : `connections.types.keyword`,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  logApp.debug(`[ELASTICSEARCH] aggregationRelationsCount`, { query });
  return el
    .search(query)
    .then(async (data) => {
      if (field === 'internal_id') {
        const { buckets } = data.body.aggregations.connections.filtered.genres;
        const filteredBuckets = R.filter((b) => b.key !== fromId, buckets);
        return R.map((b) => ({ label: b.key, value: b.doc_count }), filteredBuckets);
      }
      let fromType = null;
      if (fromId) {
        const fromEntity = await elLoadById(user, fromId);
        fromType = fromEntity.entity_type;
      }
      const types = R.pipe(
        R.map((h) => h._source.connections),
        R.flatten(),
        R.filter((c) => c.internal_id !== fromId && !R.includes(fromType, c.types)),
        R.filter((c) => toTypes.length === 0 || R.includes(R.head(toTypes), c.types)),
        R.map((e) => e.types),
        R.flatten(),
        R.uniq(),
        R.filter((f) => !isAbstract(f)),
        R.map((u) => u.toLowerCase())
      )(data.body.hits.hits);
      const { buckets } = data.body.aggregations.connections.filtered.genres;
      const filteredBuckets = R.filter((b) => R.includes(b.key, types), buckets);
      return R.map((b) => ({ label: pascalize(b.key), value: b.doc_count }), filteredBuckets);
    })
    .catch((e) => {
      throw DatabaseError('Fail processing AggregationRelationsCount', { error: e });
    });
};
export const elHistogramCount = async (user, type, field, interval, start, end, toTypes, filters) => {
  const histogramFilters = R.map((f) => {
    const { isRelation = false, isNested = false, type: filterType, value, operator = 'eq' } = f;
    if (isNested) {
      const [path] = filterType.split('.');
      return {
        nested: {
          path,
          query: {
            bool: {
              must: [{ match_phrase: { [filterType]: value } }],
            },
          },
        },
      };
    }
    let key = `${filterType}.keyword`;
    if (operator === 'wilcard') {
      key = `${filterType}`;
    }
    if (isRelation) {
      key = buildRefRelationSearchKey(filterType || '*');
    }
    return {
      multi_match: {
        fields: [key],
        type: 'phrase',
        query: value,
      },
    };
  }, filters);
  let dateFormat;
  switch (interval) {
    case 'year':
      dateFormat = 'yyyy';
      break;
    case 'month':
      dateFormat = 'yyyy-MM';
      break;
    case 'day':
      dateFormat = 'yyyy-MM-dd';
      break;
    default:
      throw FunctionalError('Unsupported interval, please choose between year, month or day', interval);
  }
  let baseFilters = [
    {
      range: {
        [field]: {
          gte: start,
          lte: end,
        },
      },
    },
  ];
  if (type) {
    baseFilters = R.append(
      {
        bool: {
          should: [
            { match_phrase: { 'entity_type.keyword': type } },
            { match_phrase: { 'parent_types.keyword': type } },
          ],
          minimum_should_match: 1,
        },
      },
      baseFilters
    );
  }
  const typesFilters = [];
  for (let index = 0; index < toTypes.length; index += 1) {
    typesFilters.push({
      match_phrase: { 'connections.types.keyword': toTypes[index] },
    });
  }
  if (typesFilters.length > 0) {
    baseFilters.push({
      nested: {
        path: 'connections',
        query: {
          bool: {
            should: typesFilters,
            minimum_should_match: 1,
          },
        },
      },
    });
  }
  const must = R.concat(baseFilters, histogramFilters);
  const markingRestrictions = buildMarkingRestriction(user);
  must.push(...markingRestrictions.must);
  const query = {
    index: READ_PLATFORM_INDICES,
    ignore_throttled: ES_IGNORE_THROTTLED,
    _source_excludes: '*', // Dont need to get anything
    body: {
      query: {
        bool: {
          must,
          must_not: markingRestrictions.must_not,
        },
      },
      aggs: {
        count_over_time: {
          date_histogram: {
            field,
            calendar_interval: interval,
            // time_zone: tzStart,
            format: dateFormat,
            keyed: true,
          },
        },
      },
    },
  };
  logApp.debug(`[ELASTICSEARCH] histogramCount`, { query });
  return el.search(query).then((data) => {
    const { buckets } = data.body.aggregations.count_over_time;
    const dataToPairs = R.toPairs(buckets);
    return R.map((b) => ({ date: R.head(b), value: R.last(b).doc_count }), dataToPairs);
  });
};

// region elastic common loader.
export const specialElasticCharsEscape = (query) => {
  return query.replace(/([+|\-*()~={}[\]:?\\])/g, '\\$1');
};
export const elPaginate = async (user, indexName, options = {}) => {
  // eslint-disable-next-line no-use-before-define
  const { ids = [], first = 200, after, orderBy = null, orderMode = 'asc' } = options;
  const { types = null, filters = [], filterMode = 'and', search = null, connectionFormat = true } = options;
  const searchAfter = after ? cursorToOffset(after) : undefined;
  let must = [];
  let mustnot = [];
  let ordering = [];
  const markingRestrictions = buildMarkingRestriction(user);
  must.push(...markingRestrictions.must);
  mustnot.push(...markingRestrictions.must_not);
  if (ids.length > 0) {
    const idsTermsPerType = [];
    const elementTypes = [ID_INTERNAL, ID_STANDARD, IDS_STIX];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      for (let indexType = 0; indexType < elementTypes.length; indexType += 1) {
        const elementType = elementTypes[indexType];
        const term = { [`${elementType}.keyword`]: id };
        idsTermsPerType.push({ term });
      }
    }
    must = R.append({ bool: { should: idsTermsPerType, minimum_should_match: 1 } }, must);
  }
  if (types !== null && types.length > 0) {
    const should = R.flatten(
      types.map((typeValue) => {
        return [
          { match_phrase: { 'entity_type.keyword': typeValue } },
          { match_phrase: { 'parent_types.keyword': typeValue } },
        ];
      })
    );
    must = R.append({ bool: { should, minimum_should_match: 1 } }, must);
  }
  let mustFilters = [];
  const validFilters = R.filter((f) => f?.values?.length > 0 || f?.nested?.length > 0, filters || []);
  if (validFilters.length > 0) {
    for (let index = 0; index < validFilters.length; index += 1) {
      const valuesFiltering = [];
      const { key, values, nested, operator = 'eq', filterMode: localFilterMode = 'or' } = validFilters[index];
      // const rulesKeys = getAttributesRulesFor(key);
      // TODO IF KEY is PART OF Rule we need to add extra fields search
      if (nested) {
        const nestedMust = [];
        for (let nestIndex = 0; nestIndex < nested.length; nestIndex += 1) {
          const nestedElement = nested[nestIndex];
          const { key: nestedKey, values: nestedValues, operator: nestedOperator = 'eq' } = nestedElement;
          const nestedShould = [];
          for (let i = 0; i < nestedValues.length; i += 1) {
            if (nestedOperator === 'wildcard') {
              nestedShould.push({
                query_string: {
                  query: `${nestedValues[i].toString()}`,
                  fields: [`${key}.${nestedKey}`],
                },
              });
            } else {
              nestedShould.push({
                match_phrase: { [`${key}.${nestedKey}`]: nestedValues[i].toString() },
              });
            }
          }
          const should = {
            bool: {
              should: nestedShould,
              minimum_should_match: localFilterMode === 'or' ? 1 : nestedShould.length,
            },
          };
          nestedMust.push(should);
        }
        const nestedQuery = {
          path: key,
          query: {
            bool: {
              must: nestedMust,
            },
          },
        };
        mustFilters = R.append({ nested: nestedQuery }, mustFilters);
      } else {
        for (let i = 0; i < values.length; i += 1) {
          if (values[i] === null) {
            mustnot = R.append({ exists: { field: key } }, mustnot);
          } else if (values[i] === 'EXISTS') {
            valuesFiltering.push({ exists: { field: key } });
          } else if (operator === 'eq') {
            const isDateOrNumber = dateAttributes.includes(key) || numericOrBooleanAttributes.includes(key);
            valuesFiltering.push({
              match_phrase: { [`${isDateOrNumber ? key : `${key}.keyword`}`]: values[i].toString() },
            });
          } else if (operator === 'match') {
            valuesFiltering.push({
              match_phrase: { [key]: values[i].toString() },
            });
          } else if (operator === 'wildcard') {
            valuesFiltering.push({
              query_string: {
                query: `"${values[i].toString()}"`,
                fields: [key],
              },
            });
          } else {
            valuesFiltering.push({ range: { [key]: { [operator]: values[i] } } });
          }
        }
        mustFilters = R.append(
          {
            bool: {
              should: valuesFiltering,
              minimum_should_match: localFilterMode === 'or' ? 1 : valuesFiltering.length,
            },
          },
          mustFilters
        );
      }
    }
  }
  if (filterMode === 'or') {
    must = R.append({ bool: { should: mustFilters, minimum_should_match: 1 } }, must);
  } else {
    must = [...must, ...mustFilters];
  }
  if (search !== null && search.length > 0) {
    // Try to decode before search
    let decodedSearch;
    try {
      decodedSearch = decodeURIComponent(search);
    } catch (e) {
      decodedSearch = search;
    }
    const cleanSearch = specialElasticCharsEscape(decodedSearch.trim());
    let finalSearch;
    if (cleanSearch.startsWith('http\\://')) {
      finalSearch = `"*${cleanSearch.replace('http\\://', '')}*"`;
    } else if (cleanSearch.startsWith('https\\://')) {
      finalSearch = `"*${cleanSearch.replace('https\\://', '')}*"`;
    } else if (cleanSearch.startsWith('"') && cleanSearch.endsWith('"')) {
      finalSearch = `${cleanSearch}`;
    } else {
      const splitSearch = cleanSearch.replace(/"/g, '\\"').split(/[\s/]+/);
      finalSearch = R.pipe(
        R.map((n) => `*${n}*`),
        R.join(' ')
      )(splitSearch);
    }
    const bool = {
      bool: {
        should: [
          {
            query_string: {
              query: finalSearch,
              analyze_wildcard: true,
              fields: ['name^5', '*'],
            },
          },
          {
            nested: {
              path: 'connections',
              query: {
                bool: {
                  must: [
                    {
                      query_string: {
                        query: finalSearch,
                        analyze_wildcard: true,
                        fields: ['connections.name^5', 'connections.*'],
                      },
                    },
                  ],
                },
              },
            },
          },
        ],
        minimum_should_match: 1,
      },
    };
    must = R.append(bool, must);
  }
  if (orderBy !== null && orderBy.length > 0) {
    const order = {};
    const orderKeyword =
      dateAttributes.includes(orderBy) || numericOrBooleanAttributes.includes(orderBy) ? orderBy : `${orderBy}.keyword`;
    order[orderKeyword] = orderMode;
    ordering = R.append(order, ordering);
    must = R.append({ exists: { field: orderKeyword } }, must);
  } else if (search !== null && search.length > 0) {
    ordering.push({ _score: 'desc' });
  } else {
    ordering.push({ 'standard_id.keyword': 'asc' });
  }
  const querySize = first || 10;
  let body = {
    size: querySize,
    sort: ordering,
    query: {
      bool: {
        must,
        must_not: mustnot,
      },
    },
  };
  if (searchAfter) {
    body = { ...body, search_after: searchAfter };
  }
  if (querySize > ES_MAX_PAGINATION) {
    const message = `You cannot ask for more than ${ES_MAX_PAGINATION} results. If you need more, please use pagination`;
    throw DatabaseError(message, { body });
  }
  const query = {
    index: indexName,
    _source_excludes: SOURCE_EXCLUDED_FIELDS,
    ignore_throttled: ES_IGNORE_THROTTLED,
    track_total_hits: true,
    body,
  };
  logApp.debug(`[ELASTICSEARCH] paginate`, { query });
  return el
    .search(query)
    .then((data) => {
      const convertedHits = R.map((n) => elDataConverter(n), data.body.hits.hits);
      if (connectionFormat) {
        const nodeHits = R.map((n) => ({ node: n, sort: n.sort }), convertedHits);
        return buildPagination(first, searchAfter, nodeHits, data.body.hits.total.value);
      }
      return convertedHits;
    })
    .catch(
      /* istanbul ignore next */ (err) => {
        // Because we create the mapping at element creation
        // We log the error only if its not a mapping not found error
        const numberOfCauses = err.meta.body.error.root_cause.length;
        const invalidMappingCauses = R.pipe(
          R.map((r) => r.reason),
          R.filter((r) => R.includes('No mapping found for', r) || R.includes('no such index', r))
        )(err.meta.body.error.root_cause);
        // If uncontrolled error, log and propagate
        if (numberOfCauses > invalidMappingCauses.length) {
          logApp.error(`[ELASTICSEARCH] Paginate fail`, { error: err, query });
          throw err;
        } else {
          return connectionFormat ? buildPagination(0, null, [], 0) : [];
        }
      }
    );
};
export const elList = async (user, indexName, options = {}) => {
  let hasNextPage = true;
  let continueProcess = true;
  let searchAfter = options.after;
  const listing = [];
  const publish = async (elements) => {
    const { callback } = options;
    if (callback) {
      const callbackResult = await callback(elements);
      continueProcess = callbackResult === true || callbackResult === undefined;
    } else {
      listing.push(...elements);
    }
  };
  while (continueProcess && hasNextPage) {
    // Force options to prevent connection format and manage search after
    const opts = { ...options, first: MAX_SEARCH_SIZE, after: searchAfter, connectionFormat: false };
    const elements = await elPaginate(user, indexName, opts);
    if (elements.length === 0 || elements.length < options.first) {
      if (elements.length > 0) {
        await publish(elements);
      }
      hasNextPage = false;
    } else {
      searchAfter = offsetToCursor(R.last(elements).sort);
      await publish(elements);
    }
  }
  return listing;
};
export const elLoadBy = async (user, field, value, type = null, indices = READ_DATA_INDICES) => {
  const opts = { filters: [{ key: field, values: [value] }], connectionFormat: false, types: type ? [type] : [] };
  const hits = await elPaginate(user, indices, opts);
  if (hits.length > 1) throw Error(`Expected only one response, found ${hits.length}`);
  return R.head(hits);
};
export const elAttributeValues = async (user, field) => {
  const markingRestrictions = buildMarkingRestriction(user);
  const isDateOrNumber = dateAttributes.includes(field) || numericOrBooleanAttributes.includes(field);
  const body = {
    query: {
      bool: {
        must: markingRestrictions.must,
        must_not: markingRestrictions.must_not,
      },
    },
    aggs: {
      values: {
        terms: {
          field: isDateOrNumber ? field : `${field}.keyword`,
        },
      },
    },
  };
  const query = {
    index: [READ_INDEX_STIX_DOMAIN_OBJECTS, READ_INDEX_STIX_CYBER_OBSERVABLE_RELATIONSHIPS],
    _source_excludes: SOURCE_EXCLUDED_FIELDS,
    ignore_throttled: ES_IGNORE_THROTTLED,
    body,
  };
  const data = await el.search(query);
  const { buckets } = data.body.aggregations.values;
  const finalResult = R.pipe(
    R.map((n) => ({ node: { id: n.key, key: n.key, value: n.key } })),
    R.sortWith([R.ascend(R.prop('value'))])
  )(buckets);
  return buildPagination(0, null, finalResult, finalResult.length);
};
// endregion

export const elBulk = async (args) => {
  return el
    .bulk(args)
    .then((result) => {
      if (result.body.errors) {
        const errors = result.body.items.map((i) => i.index?.error || i.update?.error).filter((f) => f !== undefined);
        throw DatabaseError('Error executing bulk indexing', { errors });
      }
      return result;
    })
    .catch((e) => {
      throw DatabaseError('Error updating elastic', { error: e });
    });
};
/* istanbul ignore next */
export const elReindex = async (indices) => {
  return Promise.all(
    indices.map((indexMap) => {
      return el.reindex({
        timeout: '60m',
        body: {
          source: {
            index: indexMap.source,
          },
          dest: {
            index: indexMap.dest,
          },
        },
      });
    })
  );
};
export const elIndex = async (indexName, documentBody, refresh = true) => {
  const internalId = documentBody.internal_id;
  const entityType = documentBody.entity_type ? documentBody.entity_type : '';
  logApp.debug(`[ELASTICSEARCH] index > ${entityType} ${internalId} in ${indexName}`, documentBody);
  await el
    .index({
      index: indexName,
      id: documentBody.internal_id,
      refresh,
      timeout: '60m',
      body: R.dissoc('_index', documentBody),
    })
    .catch((err) => {
      throw DatabaseError('Error indexing elastic', { error: err, body: documentBody });
    });
  return documentBody;
};
/* istanbul ignore next */
export const elUpdate = (indexName, documentId, documentBody, retry = ES_RETRY_ON_CONFLICT) => {
  return el
    .update({
      id: documentId,
      index: indexName,
      retry_on_conflict: retry,
      timeout: BULK_TIMEOUT,
      refresh: true,
      body: documentBody,
    })
    .catch((err) => {
      throw DatabaseError('Error updating elastic', { error: err, documentId, body: documentBody });
    });
};
export const elReplace = (indexName, documentId, documentBody) => {
  const doc = R.dissoc('_index', documentBody.doc);
  const entries = Object.entries(doc);
  const rawSources = [];
  for (let index = 0; index < entries.length; index += 1) {
    const [key, val] = entries[index];
    if (isEmptyField(val)) {
      rawSources.push(`ctx._source.remove('${key}')`);
    } else {
      rawSources.push(`ctx._source['${key}'] = params['${key}']`);
    }
  }
  const source = R.join(';', rawSources);
  return elUpdate(indexName, documentId, {
    script: { source, params: doc },
  });
};

const getRelatedRelations = async (user, targetIds, elements, level, cache) => {
  const elementIds = Array.isArray(targetIds) ? targetIds : [targetIds];
  const filters = [{ nested: [{ key: 'internal_id', values: elementIds }], key: 'connections' }];
  const opts = { filters, connectionFormat: false, types: [ABSTRACT_BASIC_RELATIONSHIP] };
  const hits = await elList(user, READ_RELATIONSHIPS_INDICES, opts);
  const groupResults = R.splitEvery(MAX_JS_PARAMS, hits);
  const foundRelations = [];
  for (let index = 0; index < groupResults.length; index += 1) {
    const subRels = groupResults[index];
    elements.unshift(...subRels.map((s) => ({ ...s, level })));
    const internalIds = subRels.map((g) => g.internal_id);
    const resolvedIds = internalIds.filter((f) => !cache[f]);
    foundRelations.push(...resolvedIds);
    resolvedIds.forEach((id) => {
      cache.set(id, '');
    });
  }
  // If relations find, need to recurs to find relations to relations
  if (foundRelations.length > 0) {
    const groups = R.splitEvery(MAX_SPLIT, foundRelations);
    const concurrentFetch = (gIds) => getRelatedRelations(user, gIds, elements, level + 1, cache);
    await Promise.map(groups, concurrentFetch, { concurrency: ES_MAX_CONCURRENCY });
  }
};
export const getRelationsToRemove = async (user, elements) => {
  const relationsToRemoveMap = new Map();
  const relationsToRemove = [];
  const ids = elements.map((e) => e.internal_id);
  await getRelatedRelations(user, ids, relationsToRemove, 0, relationsToRemoveMap);
  return { relations: R.flatten(relationsToRemove), relationsToRemoveMap };
};
export const elDeleteInstanceIds = async (instances) => {
  // If nothing to delete, return immediately to prevent elastic to delete everything
  if (instances.length > 0) {
    logApp.debug(`[ELASTICSEARCH] Deleting ${instances.length} instances`);
    const bodyDelete = instances.flatMap((doc) => {
      return [{ delete: { _index: doc._index, _id: doc.internal_id, retry_on_conflict: ES_RETRY_ON_CONFLICT } }];
    });
    const cachePromise = cacheDel(instances);
    const bulkPromise = elBulk({ refresh: true, timeout: BULK_TIMEOUT, body: bodyDelete });
    await Promise.all([cachePromise, bulkPromise]);
  }
};
const elRemoveRelationConnection = async (user, relsFromTo) => {
  if (relsFromTo.length > 0) {
    const idsToResolve = R.uniq(
      relsFromTo
        .map(({ relation, isFromCleanup, isToCleanup }) => {
          const ids = [];
          if (isFromCleanup) ids.push(relation.fromId);
          if (isToCleanup) ids.push(relation.toId);
          return ids;
        })
        .flat()
    );
    const dataIds = await elFindByIds(user, idsToResolve);
    const indexCache = R.mergeAll(dataIds.map((element) => ({ [element.internal_id]: element._index })));
    const bodyUpdateRaw = relsFromTo.map(({ relation, isFromCleanup, isToCleanup }) => {
      const type = buildRefRelationKey(relation.entity_type);
      const updates = [];
      const fromIndex = indexCache[relation.fromId];
      if (isFromCleanup && fromIndex) {
        const script = {
          source: `if (ctx._source['${type}'] != null) ctx._source['${type}'].removeIf(rel -> rel == params.key);`,
          params: { key: relation.toId },
        };
        updates.push([
          { update: { _index: fromIndex, _id: relation.fromId, retry_on_conflict: ES_RETRY_ON_CONFLICT } },
          { script },
        ]);
      }
      // Update to to entity
      const toIndex = indexCache[relation.toId];
      if (isToCleanup && toIndex) {
        const script = {
          source: `if (ctx._source['${type}'] != null) ctx._source['${type}'].removeIf(rel -> rel == params.key);`,
          params: { key: relation.fromId },
        };
        updates.push([
          { update: { _index: toIndex, _id: relation.toId, retry_on_conflict: ES_RETRY_ON_CONFLICT } },
          { script },
        ]);
      }
      return updates;
    });
    const bodyUpdate = R.flatten(bodyUpdateRaw);
    const cachePromise = cacheDel(dataIds);
    const bulkPromise = elBulk({ refresh: true, timeout: BULK_TIMEOUT, body: bodyUpdate });
    await Promise.all([cachePromise, bulkPromise]);
  }
};

export const elDeleteElements = async (user, elements, loaders) => {
  if (elements.length === 0) return [];
  const { stixLoadById } = loaders;
  const opts = { concurrency: ES_MAX_CONCURRENCY };
  const { relations, relationsToRemoveMap } = await getRelationsToRemove(user, elements);
  const stixRelations = relations.filter((r) => isStixRelationShipExceptMeta(r.relationship_type));
  const dependencyDeletions = await Promise.map(stixRelations, (r) => stixLoadById(user, r.internal_id), opts);
  // Compute the id that needs to be remove from rel
  const basicCleanup = elements.filter((f) => isBasicRelationship(f.entity_type));
  const cleanupRelations = relations.concat(basicCleanup);
  const relsFromToImpacts = cleanupRelations
    .map((r) => {
      const fromWillNotBeRemoved = !relationsToRemoveMap.has(r.fromId);
      const isFromCleanup = fromWillNotBeRemoved && isImpactedTypeAndSide(r.entity_type, ROLE_FROM);
      const toWillNotBeRemoved = !relationsToRemoveMap.has(r.toId);
      const isToCleanup = toWillNotBeRemoved && isImpactedTypeAndSide(r.entity_type, ROLE_TO);
      return { relation: r, isFromCleanup, isToCleanup };
    })
    .filter((r) => r.isFromCleanup || r.isToCleanup);
  // Update all rel connections that will remain
  let currentRelationsCount = 0;
  const groupsOfRelsFromTo = R.splitEvery(MAX_SPLIT, relsFromToImpacts);
  const concurrentRelsFromTo = async (relsToClean) => {
    await elRemoveRelationConnection(user, relsToClean);
    currentRelationsCount += relsToClean.length;
    logApp.debug(`[OPENCTI] Updating relations for deletion ${currentRelationsCount} / ${relsFromToImpacts.length}`);
  };
  await Promise.map(groupsOfRelsFromTo, concurrentRelsFromTo, opts);
  // Remove all relations
  let currentRelationsDelete = 0;
  const groupsOfDeletions = R.splitEvery(MAX_SPLIT, relations);
  const concurrentDeletions = async (deletions) => {
    await elDeleteInstanceIds(deletions);
    currentRelationsDelete += deletions.length;
    logApp.debug(`[OPENCTI] Deleting related relations ${currentRelationsDelete} / ${relations.length}`);
  };
  await Promise.map(groupsOfDeletions, concurrentDeletions, opts);
  // Remove the elements
  await elDeleteInstanceIds(elements); // Bulk
  // Return the relations deleted because of the entity deletion
  return dependencyDeletions;
};

export const prepareElementForIndexing = (element) => {
  const thing = {};
  Object.keys(element).forEach((key) => {
    const value = element[key];
    if (Array.isArray(value)) {
      const filteredArray = value.filter((i) => i);
      thing[key] = filteredArray.length > 0 ? filteredArray : [];
    } else if (isBooleanAttribute(key)) {
      // patch field is string generic so need to be cast to boolean
      thing[key] = typeof value === 'boolean' ? value : value?.toLowerCase() === 'true';
    } else {
      thing[key] = value;
    }
  });
  return thing;
};
const prepareRelation = (thing) => {
  if (thing.fromRole === undefined || thing.toRole === undefined) {
    throw DatabaseError(`[ELASTIC] Cant index relation ${thing.internal_id} connections without from or to`, thing);
  }
  const connections = [];
  if (!thing.from || !thing.to) {
    throw DatabaseError(`[ELASTIC] Cant index relation ${thing.internal_id}, error resolving dependency IDs`, {
      fromId: thing.fromId,
      toId: thing.toId,
    });
  }
  const { from, to } = thing;
  connections.push({
    internal_id: from.internal_id,
    name: from.name,
    types: [from.entity_type, ...getParentTypes(from.entity_type)],
    role: thing.fromRole,
  });
  connections.push({
    internal_id: to.internal_id,
    name: to.name,
    types: [to.entity_type, ...getParentTypes(to.entity_type)],
    role: thing.toRole,
  });
  return R.pipe(
    R.assoc('connections', connections),
    R.dissoc(INTERNAL_TO_FIELD),
    R.dissoc(INTERNAL_FROM_FIELD),
    // Dissoc from
    R.dissoc('from'),
    R.dissoc('fromId'),
    R.dissoc('fromRole'),
    // Dissoc to
    R.dissoc('to'),
    R.dissoc('toId'),
    R.dissoc('toRole')
  )(thing);
};
const prepareEntity = (thing) => {
  return R.pipe(R.dissoc(INTERNAL_TO_FIELD), R.dissoc(INTERNAL_FROM_FIELD))(thing);
};
const prepareIndexing = async (elements) => {
  return Promise.all(
    R.map(async (element) => {
      // Ensure empty list are not indexed
      const thing = prepareElementForIndexing(element);
      // For relation, index a list of connections.
      if (thing.base_type === BASE_TYPE_RELATION) {
        return prepareRelation(thing);
      }
      return prepareEntity(thing);
    }, elements)
  );
};
export const elIndexElements = async (elements) => {
  // 00. Relations must be transformed before indexing.
  const transformedElements = await prepareIndexing(elements);
  // 01. Bulk the indexing of row elements
  const body = transformedElements.flatMap((doc) => [
    { index: { _index: doc._index, _id: doc.internal_id, retry_on_conflict: ES_RETRY_ON_CONFLICT } },
    R.pipe(R.dissoc('_index'))(doc),
  ]);
  if (body.length > 0) {
    await elBulk({ refresh: true, body });
  }
  // 02. If relation, generate impacts for from and to sides
  const cache = {};
  const impactedEntities = R.pipe(
    R.filter((e) => e.base_type === BASE_TYPE_RELATION),
    R.map((e) => {
      const { fromRole, toRole } = e;
      const relationshipType = e.entity_type;
      const impacts = [];
      // We impact target entities of the relation only if not global entities like
      // MarkingDefinition (marking) / KillChainPhase (kill_chain_phase) / Label (tagging)
      cache[e.fromId] = e.from;
      cache[e.toId] = e.to;
      if (isImpactedRole(fromRole)) {
        impacts.push({ from: e.fromId, relationshipType, to: e.to });
      }
      if (isImpactedRole(toRole)) {
        impacts.push({ from: e.toId, relationshipType, to: e.from });
      }
      return impacts;
    }),
    R.flatten,
    R.groupBy((i) => i.from)
  )(elements);
  const elementsToUpdate = await Promise.all(
    // For each from, generate the
    R.map(async (entityId) => {
      const entity = cache[entityId];
      const targets = impactedEntities[entityId];
      // Build document fields to update ( per relation type )
      const targetsByRelation = R.groupBy((i) => i.relationshipType, targets);
      const targetsElements = await Promise.all(
        R.map(async (relType) => {
          const data = targetsByRelation[relType];
          const resolvedData = await Promise.all(
            R.map(async (d) => {
              return d.to.internal_id;
            }, data)
          );
          return { relation: relType, elements: resolvedData };
        }, Object.keys(targetsByRelation))
      );
      // Create params and scripted update
      const params = {};
      const sources = R.map((t) => {
        const field = buildRefRelationKey(t.relation);
        const createIfNotExist = `if (ctx._source['${field}'] == null) ctx._source['${field}'] = [];`;
        const addAllElements = `ctx._source['${field}'].addAll(params['${field}'])`;
        return `${createIfNotExist} ${addAllElements}`;
      }, targetsElements);
      const source = sources.length > 1 ? R.join(';', sources) : `${R.head(sources)};`;
      for (let index = 0; index < targetsElements.length; index += 1) {
        const targetElement = targetsElements[index];
        params[buildRefRelationKey(targetElement.relation)] = targetElement.elements;
      }
      return { ...entity, id: entityId, data: { script: { source, params } } };
    }, Object.keys(impactedEntities))
  );
  const bodyUpdate = elementsToUpdate.flatMap((doc) => [
    { update: { _index: doc._index, _id: doc.id, retry_on_conflict: ES_RETRY_ON_CONFLICT } },
    R.dissoc('_index', doc.data),
  ]);
  if (bodyUpdate.length > 0) {
    const bulkPromise = elBulk({ refresh: true, timeout: BULK_TIMEOUT, body: bodyUpdate });
    const cachePromise = cacheDel(elementsToUpdate);
    await Promise.all([cachePromise, bulkPromise]);
  }
  return transformedElements.length;
};

export const elUpdateAttributeValue = async (key, previousValue, value) => {
  const isMultiple = isMultipleAttribute(key);
  const source = !isMultiple
    ? 'ctx._source[params.key] = params.value'
    : `def index = 0; 
       for (att in ctx._source[params.key]) { 
        if(att == params.previousValue) { 
          ctx._source[params.key][index] = params.value; 
        } 
        index++; 
       }`;
  const query = { match_phrase: { [`${key}.keyword`]: previousValue } };
  const params = {
    index: READ_DATA_INDICES,
    refresh: false,
    body: {
      script: { source, params: { key, value, previousValue } },
      query,
    },
  };
  const cachePromise = cachePurge();
  const updatePromise = el.updateByQuery(params).catch((err) => {
    throw DatabaseError('Updating attribute value fail', { error: err, key, value });
  });
  await Promise.all([cachePromise, updatePromise]);
};
export const elUpdateRelationConnections = async (elements) => {
  if (elements.length > 0) {
    const source =
      'def conn = ctx._source.connections.find(c -> c.internal_id == params.id); ' +
      'for (change in params.changes.entrySet()) { conn[change.getKey()] = change.getValue() }';
    const bodyUpdate = elements.flatMap((doc) => [
      { update: { _index: doc._index, _id: doc.id, retry_on_conflict: ES_RETRY_ON_CONFLICT } },
      { script: { source, params: { id: doc.toReplace, changes: doc.data } } },
    ]);
    const bulkPromise = elBulk({ refresh: true, timeout: BULK_TIMEOUT, body: bodyUpdate });
    const cachePromise = cacheDel(elements);
    await Promise.all([cachePromise, bulkPromise]);
  }
};
export const elUpdateEntityConnections = async (elements) => {
  if (elements.length > 0) {
    const source = `if (ctx._source[params.key] == null) { 
      ctx._source[params.key] = [params.to];
    } else if (params.from == null) {
      ctx._source[params.key].addAll(params.to);
    } else {
      def values = [params.to];
      for (current in ctx._source[params.key]) { 
        if (current != params.from) { values.add(current); }
      }
      ctx._source[params.key] = values;
    }
  `;
    const addMultipleFormat = (doc) => {
      if (doc.toReplace === null && !Array.isArray(doc.data.internal_id)) {
        return [doc.data.internal_id];
      }
      return doc.data.internal_id;
    };
    const bodyUpdate = elements.flatMap((doc) => [
      { update: { _index: doc._index, _id: doc.id, retry_on_conflict: ES_RETRY_ON_CONFLICT } },
      {
        script: {
          source,
          params: { key: buildRefRelationKey(doc.relationType), from: doc.toReplace, to: addMultipleFormat(doc) },
        },
      },
    ]);
    const bulkPromise = elBulk({ refresh: true, timeout: BULK_TIMEOUT, body: bodyUpdate });
    const cachePromise = cacheDel(elements);
    await Promise.all([cachePromise, bulkPromise]);
  }
};

export const elUpdateConnectionsOfElement = async (documentId, documentBody) => {
  const source =
    'def conn = ctx._source.connections.find(c -> c.internal_id == params.id); ' +
    'for (change in params.changes.entrySet()) { conn[change.getKey()] = change.getValue() }';
  return el
    .updateByQuery({
      index: READ_RELATIONSHIPS_INDICES,
      refresh: true,
      body: {
        script: { source, params: { id: documentId, changes: documentBody } },
        query: {
          nested: {
            path: 'connections',
            query: {
              bool: {
                must: [{ match_phrase: { [`connections.internal_id.keyword`]: documentId } }],
              },
            },
          },
        },
      },
    })
    .catch((err) => {
      throw DatabaseError('Error updating elastic', { error: err, documentId, body: documentBody });
    });
};
export const elUpdateElement = async (instance) => {
  // Update the element it self
  const esData = prepareElementForIndexing(instance);
  // Set the cache
  const cachePromise = cacheDel([esData]);
  const replacePromise = elReplace(instance._index, instance.internal_id, { doc: esData });
  // If entity with a name, must update connections
  let connectionPromise = Promise.resolve();
  if (esData.name && isStixObject(instance.entity_type)) {
    connectionPromise = elUpdateConnectionsOfElement(instance.internal_id, { name: esData.name });
  }
  await Promise.all([cachePromise, replacePromise, connectionPromise]);
};

export const getStats = () => {
  return el.indices.stats({ index: READ_PLATFORM_INDICES }).then((result) => result.body._all.total);
};
