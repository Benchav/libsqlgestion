import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne } from 'typeorm';
import { Project } from './Project';

@Entity('databases')
export class Database {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column()
  type!: string; // sqlite | libsql | remote

  @Column({ nullable: true })
  url?: string;

  @Column({ nullable: true })
  encryptedToken?: string;

  @ManyToOne(() => Project)
  project!: Project;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
