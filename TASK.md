I want to create a http server that will server files in a dynamic fashion.
It will have an endpoint for clients to register a folder to be served and it will generate a slug for that folder and the folder will be served at http(s)://<host>:<port>/slug and http(s)://<slug>.<host>:<port>.
The root endpoint will be http(s)://<host>:<port>/ and it will list all the registered folders with their slugs and links to access them if the http method is GET, and it will allow clients to register a new folder if the http method is POST. The POST request will have a JSON body with the following structure:
{
    "folder_path": "/path/to/folder"
}
If http method is DELETE, it will allow clients to unregister a folder by providing the slug or the folder_path .
If http method is PUT, it will allow clients to update the folder path for a given slug by providing the slug and the new folder_path in the JSON body or update the slug by providing the folder_path.
All operations will return appropriate HTTP status codes and messages in case of success or failure. The message must be suitable for humans and LLM AI Agents.
The home dashboard will allow to execute all 4 operations: GET, POST, DELETE, and PUT. It will have a user-friendly interface to manage the registered folders and their slugs. The dashboard will display the list of registered folders with their slugs and provide options to add new folders, delete existing ones, and update folder paths or slugs.

---

Initially we will be using http (no https) and localhost. The initial focus is constructing the backend server with the specified endpoints and functionality. Once the backend is functional, we can then proceed to create the frontend dashboard for managing the registered folders and their slugs.
