// Stand-in for archstrict's own shipped Config type. Generic over the
// generated module-name union, so a typo in `deprecated`'s `from`/`to`
// (a real module name, not an arbitrary string) fails tsc rather than
// silently matching nothing at check time.
export type Config<ModuleName extends string> = {
  modules: string;
  layers: readonly ModuleName[];
  deprecated?: readonly {
    from: ModuleName;
    to: ModuleName;
    count: number;
    because: string;
  }[];
  because: string;
};
