create table `ddl_old` (`id` bigint primary key auto_increment, `title` varchar(255) not null, `created_at` datetime(3) default (utc_timestamp(3)) not null, `updated_at` datetime(3) default (utc_timestamp(3)) not null) default character set utf8mb4 collate utf8mb4_0900_bin;
create index `ddl_old_title_index` on `ddl_old` (`title`);
alter table `ddl_people` rename to `ddl_persons`;
alter table `ddl_old` rename to `ddl_new`, rename index `ddl_old_title_index` to `ddl_new_title_index`;
