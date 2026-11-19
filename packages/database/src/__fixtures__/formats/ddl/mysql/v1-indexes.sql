create table `ddl_indexed` (`id` bigint primary key auto_increment, `a` varchar(255) not null, `b` varchar(255) not null, `c` varchar(255) not null) default character set utf8mb4 collate utf8mb4_0900_bin;
create unique index `ddl_indexed_c_unique` on `ddl_indexed` (`c`);
create index `ddl_indexed_a_index` on `ddl_indexed` (`a`);
create index `ddl_indexed_a_b_index` on `ddl_indexed` (`a`, `b`);
create index `ddl_indexed_named_b` on `ddl_indexed` (`b`);
create unique index `ddl_indexed_a_unique` on `ddl_indexed` (`a`);
create unique index `ddl_indexed_named_ab` on `ddl_indexed` (`a`, `b`);
