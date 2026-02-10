-- Enable realtime for tables that need live sync
ALTER PUBLICATION supabase_realtime ADD TABLE items;
ALTER PUBLICATION supabase_realtime ADD TABLE lists;
ALTER PUBLICATION supabase_realtime ADD TABLE collaborators;
