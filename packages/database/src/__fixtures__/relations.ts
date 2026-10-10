// What `db:types` generates as `Relations` for the fixture migrations `auth`, `relations`, `relations-readers` and
// `relations-secrets` — so the package's tests can type `with()`. Imported for its declarations only; the shipped package has none
// of them.

declare module '../types.ts' {
  interface Relations {
    api_keys: {
      user: { kind: 'belongsTo'; table: 'users'; foreignKey: 'user_id'; localKey: 'user_id'; targetKey: 'id'; nullable: true };
    };
    categories: {
      categories: { kind: 'hasMany'; table: 'categories'; foreignKey: 'parent_id'; localKey: 'id'; targetKey: 'parent_id' };
      parent: { kind: 'belongsTo'; table: 'categories'; foreignKey: 'parent_id'; localKey: 'parent_id'; targetKey: 'id'; nullable: true };
    };
    comments: {
      post: { kind: 'belongsTo'; table: 'posts'; foreignKey: 'post_id'; localKey: 'post_id'; targetKey: 'id'; nullable: false };
      user: { kind: 'belongsTo'; table: 'users'; foreignKey: 'user_id'; localKey: 'user_id'; targetKey: 'id'; nullable: true };
    };
    post_stats: {
      post: { kind: 'belongsTo'; table: 'posts'; foreignKey: 'post_id'; localKey: 'post_id'; targetKey: 'id'; nullable: false };
    };
    post_tag: {
      post: { kind: 'belongsTo'; table: 'posts'; foreignKey: 'post_id'; localKey: 'post_id'; targetKey: 'id'; nullable: false };
      tag: { kind: 'belongsTo'; table: 'tags'; foreignKey: 'tag_id'; localKey: 'tag_id'; targetKey: 'id'; nullable: false };
    };
    post_user: {
      post: { kind: 'belongsTo'; table: 'posts'; foreignKey: 'post_id'; localKey: 'post_id'; targetKey: 'id'; nullable: false };
      user: { kind: 'belongsTo'; table: 'users'; foreignKey: 'user_id'; localKey: 'user_id'; targetKey: 'id'; nullable: true };
    };
    posts: {
      author: { kind: 'belongsTo'; table: 'users'; foreignKey: 'author_id'; localKey: 'author_id'; targetKey: 'id'; nullable: true };
      comments: { kind: 'hasMany'; table: 'comments'; foreignKey: 'post_id'; localKey: 'id'; targetKey: 'post_id' };
      editor: { kind: 'belongsTo'; table: 'users'; foreignKey: 'editor_id'; localKey: 'editor_id'; targetKey: 'id'; nullable: true };
      post_stats: { kind: 'hasOne'; table: 'post_stats'; foreignKey: 'post_id'; localKey: 'id'; targetKey: 'post_id'; nullable: true };
      post_tag: { kind: 'hasMany'; table: 'post_tag'; foreignKey: 'post_id'; localKey: 'id'; targetKey: 'post_id' };
      post_user: { kind: 'hasMany'; table: 'post_user'; foreignKey: 'post_id'; localKey: 'id'; targetKey: 'post_id' };
      tags: { kind: 'belongsToMany'; table: 'tags'; pivot: 'post_tag'; foreignKey: 'post_id'; relatedKey: 'tag_id'; localKey: 'id'; targetKey: 'id' };
      users: { kind: 'belongsToMany'; table: 'users'; pivot: 'post_user'; foreignKey: 'post_id'; relatedKey: 'user_id'; localKey: 'id'; targetKey: 'id' };
    };
    tags: {
      post_tag: { kind: 'hasMany'; table: 'post_tag'; foreignKey: 'tag_id'; localKey: 'id'; targetKey: 'tag_id' };
      posts: { kind: 'belongsToMany'; table: 'posts'; pivot: 'post_tag'; foreignKey: 'tag_id'; relatedKey: 'post_id'; localKey: 'id'; targetKey: 'id' };
    };
    users: {
      api_keys: { kind: 'hasMany'; table: 'api_keys'; foreignKey: 'user_id'; localKey: 'id'; targetKey: 'user_id' };
      authored_posts: { kind: 'hasMany'; table: 'posts'; foreignKey: 'author_id'; localKey: 'id'; targetKey: 'author_id' };
      comments: { kind: 'hasMany'; table: 'comments'; foreignKey: 'user_id'; localKey: 'id'; targetKey: 'user_id' };
      edited_posts: { kind: 'hasMany'; table: 'posts'; foreignKey: 'editor_id'; localKey: 'id'; targetKey: 'editor_id' };
      post_user: { kind: 'hasMany'; table: 'post_user'; foreignKey: 'user_id'; localKey: 'id'; targetKey: 'user_id' };
      posts: { kind: 'belongsToMany'; table: 'posts'; pivot: 'post_user'; foreignKey: 'user_id'; relatedKey: 'post_id'; localKey: 'id'; targetKey: 'id' };
    };
  }
}

export {};
