create table `ddl_checked` (`id` bigint primary key auto_increment, `role` varchar(255) default 'admin' not null constraint `ddl_checked_role_check` check (`role` in ('admin', 'o''brien')), `state` varchar(20) constraint `ddl_checked_state_check` check (`state` in ('open', 'closed')), `seats` integer default 1 not null, constraint `ddl_checked_seats_check` check (seats > 0)) default character set utf8mb4 collate utf8mb4_0900_bin;
alter table `ddl_checked` add column `kind` longtext default ('a') not null constraint `ddl_checked_kind_check` check (`kind` in ('a', 'b'));
alter table `ddl_checked` drop constraint `ddl_checked_seats_check`;
alter table `ddl_checked` add constraint `ddl_checked_seats_check` check (seats between 1 and 9);
alter table `ddl_checked` drop constraint `ddl_checked_role_check`, add constraint `ddl_checked_role_check` check (`role` in ('admin', 'owner', 'o''brien'));
