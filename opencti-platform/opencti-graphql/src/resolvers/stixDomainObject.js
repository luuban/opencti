import { withFilter } from 'graphql-subscriptions';
import { assoc } from 'ramda';
import { BUS_TOPICS } from '../config/conf';
import {
  findAll,
  findById,
  stixDomainObjectsNumber,
  stixDomainObjectsDistributionByEntity,
  stixDomainObjectsTimeSeries,
  addStixDomainObject,
  stixDomainObjectAddRelation,
  stixDomainObjectAddRelations,
  stixDomainObjectCleanContext,
  stixDomainObjectDelete,
  stixDomainObjectsDelete,
  stixDomainObjectDeleteRelation,
  stixDomainObjectEditContext,
  stixDomainObjectEditField,
  stixDomainObjectExportAsk,
  stixDomainObjectExportPush,
  stixDomainObjectImportPush,
  stixDomainObjectsExportPush,
  stixDomainObjectsExportAsk,
  stixDomainObjectsTimeSeriesByAuthor,
} from '../domain/stixDomainObject';
import { pubsub } from '../database/redis';
import withCancel from '../graphql/subscriptionWrapper';
import { filesListing } from '../database/minio';
import { ABSTRACT_STIX_DOMAIN_OBJECT } from '../schema/general';
import { stixDomainObjectOptions } from '../schema/stixDomainObject';

const stixDomainObjectResolvers = {
  Query: {
    stixDomainObject: (_, { id }, { user }) => findById(user, id),
    stixDomainObjects: (_, args, { user }) => findAll(user, args),
    stixDomainObjectsTimeSeries: (_, args, { user }) => {
      if (args.authorId && args.authorId.length > 0) {
        return stixDomainObjectsTimeSeriesByAuthor(user, args);
      }
      return stixDomainObjectsTimeSeries(user, args);
    },
    stixDomainObjectsNumber: (_, args, { user }) => stixDomainObjectsNumber(user, args),
    stixDomainObjectsDistribution: (_, args, { user }) => {
      if (args.objectId && args.objectId.length > 0) {
        return stixDomainObjectsDistributionByEntity(user, args);
      }
      return [];
    },
    stixDomainObjectsExportFiles: (_, { type, first }, { user }) => filesListing(user, first, `export/${type}/`),
  },
  StixDomainObjectsFilter: stixDomainObjectOptions.StixDomainObjectsFilter,
  StixDomainObject: {
    __resolveType(obj) {
      if (obj.entity_type) {
        return obj.entity_type.replace(/(?:^|-)(\w)/g, (matches, letter) => letter.toUpperCase());
      }
      return 'Unknown';
    },
    importFiles: (entity, { first }, { user }) =>
      filesListing(user, first, `import/${entity.entity_type}/${entity.id}/`),
    exportFiles: (entity, { first }, { user }) =>
      filesListing(user, first, `export/${entity.entity_type}/${entity.id}/`),
  },
  Mutation: {
    stixDomainObjectEdit: (_, { id }, { user }) => ({
      delete: () => stixDomainObjectDelete(user, id),
      fieldPatch: ({ input }) => stixDomainObjectEditField(user, id, input),
      contextPatch: ({ input }) => stixDomainObjectEditContext(user, id, input),
      contextClean: () => stixDomainObjectCleanContext(user, id),
      relationAdd: ({ input }) => stixDomainObjectAddRelation(user, id, input),
      relationsAdd: ({ input }) => stixDomainObjectAddRelations(user, id, input),
      relationDelete: ({ toId, relationship_type: relationshipType }) =>
        stixDomainObjectDeleteRelation(user, id, toId, relationshipType),
      importPush: ({ file }) => stixDomainObjectImportPush(user, id, file),
      exportAsk: (args) => stixDomainObjectExportAsk(user, assoc('stixDomainObjectId', id, args)),
      exportPush: ({ file }) => stixDomainObjectExportPush(user, id, file),
    }),
    stixDomainObjectsDelete: (_, { id }, { user }) => stixDomainObjectsDelete(user, id),
    stixDomainObjectAdd: (_, { input }, { user }) => addStixDomainObject(user, input),
    stixDomainObjectsExportAsk: (_, args, { user }) => stixDomainObjectsExportAsk(user, args),
    stixDomainObjectsExportPush: (_, { type, file, listFilters }, { user }) =>
      stixDomainObjectsExportPush(user, type, file, listFilters),
  },
  Subscription: {
    stixDomainObject: {
      resolve: /* istanbul ignore next */ (payload) => payload.instance,
      subscribe: /* istanbul ignore next */ (_, { id }, { user }) => {
        stixDomainObjectEditContext(user, id);
        const filtering = withFilter(
          () => pubsub.asyncIterator(BUS_TOPICS[ABSTRACT_STIX_DOMAIN_OBJECT].EDIT_TOPIC),
          (payload) => {
            if (!payload) return false; // When disconnect, an empty payload is dispatched.
            return payload.user.id !== user.id && payload.instance.id === id;
          }
        )(_, { id }, { user });
        return withCancel(filtering, () => {
          stixDomainObjectCleanContext(user, id);
        });
      },
    },
  },
};

export default stixDomainObjectResolvers;
